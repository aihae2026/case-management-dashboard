// ================================================================
// 복순이(bright-day-talk) 전용 구글 드라이브 웹앱 + 일일 채팅 백업
//
// [배포 방법]
// 1. Google Apps Script (script.google.com) 에 새 프로젝트 생성
// 2. 이 파일 전체 복붙
// 3. 프로젝트 설정 > 스크립트 속성에 아래 두 항목을 직접 입력
//    (코드에 비밀값을 적지 않도록 setup()은 SERVICE_ROLE_KEY만 저장합니다)
// 4. dailyBackup() 실행 — 테스트 (실패 알림 메일 권한을 처음 한 번 승인해야 합니다)
// 5. 트리거: dailyBackup / 일 타이머 / 오전 1~2시 KST
//
// [Script Properties 필요 항목]
// - SERVICE_ROLE_KEY : bright-day-talk Supabase 서비스롤 키 (절대 코드에 직접 입력 금지)
// - UPLOAD_SECRET    : doPost 릴레이 인증 키. 기본값이 없어서 미설정이면 업로드를 거부합니다.
//                      Supabase Edge Function 시크릿 DRIVE_SECRET과 같은 값이어야 합니다.
//
// [백업 동작]
// - 한 명이 실패해도 나머지는 계속 백업하고, 끝나면 실패한 분 목록을 메일로 알립니다.
// - 시간 한도로 멈추면 그 위치를 기억해 다음 실행에서 이어서 하고, 끝까지 가면 처음 쪽으로 돌아가
//   빠진 분도 채웁니다. (그래서 같은 사람만 매번 먼저 백업되고 뒷사람이 밀리는 일이 없습니다)
// - 연속으로 3명이 실패하면 서버 문제로 보고 중단한 뒤 메일로 알립니다.
// ================================================================

const UPLOAD_FOLDER_ID   = '<Drive 폴더 ID>';
const BACKUP_FOLDER_NAME = '[복순이 채팅 백업]';
const SUPABASE_URL       = 'https://<프로젝트 ID>.supabase.co';
const MAX_RUN_MS         = 5 * 60 * 1000; // Apps Script 실행 한도(6분)를 넘기기 전에 멈춘다
const MAX_CELL_CHARS     = 45000;         // 스프레드시트 칸 하나의 한도(5만 자)를 넘지 않게 자른다
const MAX_CONSECUTIVE_FAILS = 3;          // 연속 실패가 이만큼이면 서버 문제로 보고 중단한다

// ── 키는 Script Properties에서 읽기 ─────────────────────────
function getUploadSecret() {
  return PropertiesService.getScriptProperties().getProperty('UPLOAD_SECRET');
}
function getServiceKey() {
  return PropertiesService.getScriptProperties().getProperty('SERVICE_ROLE_KEY');
}

// ── 파일 업로드 릴레이 (on-demand) ──────────────────────────
function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var secret = getUploadSecret();
    if (!secret) return json({ error: 'UPLOAD_SECRET 미설정' });
    if (params.secret !== secret) return json({ error: '인증 실패' });

    var blob = Utilities.newBlob(
      Utilities.base64Decode(params.data), params.mimeType, params.name
    );
    var rootFolder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
    var targetFolder = rootFolder;
    if (params.folderName) {
      var existing = rootFolder.getFoldersByName(params.folderName);
      targetFolder = existing.hasNext() ? existing.next() : rootFolder.createFolder(params.folderName);
    }
    var file = targetFolder.createFile(blob);
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    return json({
      id:   file.getId(),
      name: file.getName(),
      url:  'https://drive.google.com/file/d/' + file.getId() + '/view',
      size: file.getSize()
    });
  } catch (err) {
    return json({ error: err.message });
  }
}

function doGet() {
  return json({ status: 'ok', service: '복순이 Drive 릴레이' });
}

// ── Supabase REST는 한 번에 최대 1,000행만 주므로 offset으로 끝까지 읽는다 ──
function fetchAllRows(path, headers) {
  var PAGE = 1000;
  var all = [];
  var offset = 0;
  while (true) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    var resp = UrlFetchApp.fetch(
      SUPABASE_URL + path + sep + 'limit=' + PAGE + '&offset=' + offset,
      { headers: headers }
    );
    var batch = JSON.parse(resp.getContentText());
    // 오류 응답({message: ...})을 행 목록으로 착각하지 않게 막는다
    if (!Array.isArray(batch)) throw new Error('Supabase 응답이 목록이 아닙니다: ' + resp.getContentText().slice(0, 200));
    all = all.concat(batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// ── 실패하면 스크립트 소유자에게 메일로 알린다 ───────────────
function notifyFailure(subject, body) {
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '[복순이] ' + subject, body);
  } catch (mailErr) {
    Logger.log('알림 메일 전송 실패: ' + mailErr.message);
  }
}

// ── 일일 채팅 백업 (트리거로 자동 실행) ─────────────────────
function dailyBackup() {
  try {
    Logger.log(runDailyBackup());
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    Logger.log('❌ 백업 실패: ' + msg);
    notifyFailure('일일 백업 실패', msg);
    throw err;
  }
}

// 어르신 한 명의 대화를 스프레드시트로 만들어 백업 폴더에 넣는다. 만든 스프레드시트의 id를 돌려준다.
// 중간에 실패하면 만들다 만 파일을 휴지통으로 보내고 오류를 그대로 던진다.
function backupOneSenior(senior, headers, folder, today) {
  var ss = null;
  try {
    // 해당 어르신 전체 대화 조회 (1,000건을 넘어도 끝까지)
    var messages = fetchAllRows(
      '/rest/v1/chat_messages'
      + '?select=role,content,created_at'
      + '&session_id=eq.' + encodeURIComponent(senior.session_id)
      + '&order=created_at.asc,id.asc',
      headers
    );
    if (!messages.length) return null;

    // 이름이 같은 어르신끼리 파일이 덮어써지지 않도록 고유번호(없으면 세션 앞 8자)를 넣는다
    var filename = senior.name + '_' + (senior.short_code || String(senior.session_id).slice(0, 8)) + '_' + today;

    // 오늘 중복 파일 삭제 (재실행 시 중복 방지)
    var dup = folder.getFilesByName(filename);
    while (dup.hasNext()) dup.next().setTrashed(true);

    // 새 스프레드시트 생성
    ss = SpreadsheetApp.create(filename);
    var sheet = ss.getActiveSheet();
    sheet.setName('대화기록');
    sheet.getRange(1, 1, 1, 3).setValues([['날짜', '역할', '내용']]);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#f0f4f8');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 150);
    sheet.setColumnWidth(2, 70);
    sheet.setColumnWidth(3, 500);

    var rows = messages.map(function(m) {
      return [new Date(m.created_at), m.role === 'user' ? '어르신' : '복순이', String(m.content).slice(0, MAX_CELL_CHARS)];
    });
    // 역할·내용 칸을 일반 텍스트로 지정한 뒤 넣는다. 지정하지 않으면 "="로 시작하는 채팅 내용이 수식으로 해석된다.
    sheet.getRange(2, 2, rows.length, 2).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');

    // 기본정보 탭
    var info = ss.insertSheet('기본정보');
    info.getRange(1, 1, 4, 2).setValues([
      ['어르신 성함', senior.name],
      ['기관 코드',   senior.org_code || '-'],
      ['백업 일자',   today],
      ['총 메시지',   messages.length + '건']
    ]);
    info.setColumnWidth(1, 120);
    info.setColumnWidth(2, 200);

    // 지정 폴더로 이동
    var file = DriveApp.getFileById(ss.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);

    Logger.log('✅ ' + filename + ' (' + messages.length + '건)');
    return ss.getId();
  } catch (err) {
    // 만들다 만 파일이 내 드라이브에 남지 않도록 치운다
    if (ss) {
      try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (cleanErr) { /* 치우지 못해도 계속 */ }
    }
    throw err;
  }
}

function runDailyBackup() {
  var key = getServiceKey();
  if (!key) throw new Error('SERVICE_ROLE_KEY 없음 — 스크립트 속성에 먼저 입력하세요');

  var headers = { apikey: key, Authorization: 'Bearer ' + key };
  var startedAt = Date.now();

  // 백업 폴더 가져오기 (없으면 생성)
  var root   = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
  var iter   = root.getFoldersByName(BACKUP_FOLDER_NAME);
  var folder = iter.hasNext() ? iter.next() : root.createFolder(BACKUP_FOLDER_NAME);

  // 오늘 날짜 KST
  var kst   = new Date(Date.now() + 9 * 60 * 60 * 1000);
  var today = Utilities.formatDate(kst, 'UTC', 'yyyyMMdd');

  // 어르신 목록
  var seniors = fetchAllRows('/rest/v1/seniors?select=session_id,name,org_code,short_code&order=id.asc', headers);
  if (!seniors.length) return '어르신 없음';

  // 지난번에 시간 한도로 멈춘 위치부터 시작한다 (없으면 처음부터).
  // 끝까지 가면 처음 쪽으로 돌아가서 건너뛴 분도 채운다. 그래야 뒷사람이 계속 밀리지 않는다.
  var props = PropertiesService.getScriptProperties();
  var start = parseInt(props.getProperty('BACKUP_CURSOR') || '0', 10);
  if (isNaN(start) || start < 0 || start >= seniors.length) start = 0;

  var count = 0;
  var stoppedAt = -1;
  var failures = [];
  var consecutiveFails = 0;
  for (var k = 0; k < seniors.length; k++) {
    var i = (start + k) % seniors.length;
    var senior = seniors[i];
    if (!senior.name) continue;

    // 실행 시간 한도가 가까워지면 멈추고 그 위치를 기억해 둔다
    if (Date.now() - startedAt > MAX_RUN_MS) {
      stoppedAt = i;
      break;
    }

    try {
      var made = backupOneSenior(senior, headers, folder, today);
      if (made) count++;
      consecutiveFails = 0;
    } catch (err) {
      // 한 명이 실패해도 나머지는 계속한다. 실패한 분은 끝에 모아서 메일로 알린다.
      var label = senior.name + '(' + (senior.short_code || String(senior.session_id).slice(0, 8)) + ')';
      var reason = err && err.message ? err.message : String(err);
      failures.push(label + ': ' + reason);
      Logger.log('⚠️ ' + label + ' 백업 실패: ' + reason);
      consecutiveFails++;
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        props.setProperty('BACKUP_CURSOR', String(i)); // 문제가 풀리면 여기서부터 다시 시작
        throw new Error('연속으로 ' + consecutiveFails + '명 백업에 실패해 중단합니다. (완료 ' + count + '명)\n' + failures.join('\n'));
      }
    }
  }

  var failText = failures.length ? '\n\n백업에 실패한 분 (' + failures.length + '명):\n' + failures.join('\n') : '';

  if (stoppedAt >= 0) {
    // 이름이 있는 사람만 남은 인원으로 센다. 멈춘 위치부터 한 바퀴를 채우지 못한 만큼이다.
    var remaining = 0;
    for (var j = 0; j < seniors.length; j++) {
      var idx = (start + j) % seniors.length;
      if (j >= (stoppedAt - start + seniors.length) % seniors.length && seniors[idx].name) remaining++;
    }
    props.setProperty('BACKUP_CURSOR', String(stoppedAt));
    notifyFailure(
      '일일 백업이 일부만 끝났어요',
      '실행 시간 한도 때문에 오늘은 ' + remaining + '명을 백업하지 못했습니다. (완료 ' + count + '명, ' + today + ')\n'
      + '다음 실행에서 멈춘 곳부터 이어서 백업합니다. 지금 바로 이어가려면 dailyBackup을 한 번 더 실행하세요.'
      + failText
    );
    return '⏸ 일부 완료: ' + count + '명 (남은 ' + remaining + '명은 다음 실행에서 이어서) / ' + today;
  }

  props.deleteProperty('BACKUP_CURSOR');
  if (failures.length) {
    notifyFailure(
      '일부 어르신 백업에 실패했어요',
      '오늘(' + today + ') ' + count + '명은 백업했고 ' + failures.length + '명은 실패했습니다. 나머지는 정상입니다.'
      + failText
    );
    return '⚠️ 백업 완료(실패 ' + failures.length + '명): ' + count + '명 / ' + today;
  }
  return '🎉 백업 완료: ' + count + '명 / ' + today;
}

// ── 최초 1회만 실행 (서비스 키 등록) ─────────────────────────
// 주의: JWT 키를 한 줄 문자열로 넣으면 에디터에서 줄바꿈이 끼어 401 오류 발생
//       반드시 + 연결로 분리해서 저장할 것 (아래 예시 참고)
// 실제 키는 Supabase 대시보드 > Project Settings > API > service_role 에서 복사
// UPLOAD_SECRET은 여기서 저장하지 않습니다. 스크립트 속성에 직접 입력하세요.
function setup() {
  var key = 'SUPABASE_SERVICE_ROLE_KEY_여기에_붙여넣기';
  // 긴 JWT는 아래처럼 + 로 이어서 붙여야 줄바꿈 없이 저장됨:
  // var key = 'eyJhbGci...(헤더부분)'
  //   + '.eyJpc3M...(페이로드부분)'
  //   + '.(서명부분)';
  PropertiesService.getScriptProperties().setProperty('SERVICE_ROLE_KEY', key);
  Logger.log('✅ SERVICE_ROLE_KEY 등록 완료 (' + key.length + '자)');
}

// ── 공통 JSON 응답 ───────────────────────────────────────────
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
