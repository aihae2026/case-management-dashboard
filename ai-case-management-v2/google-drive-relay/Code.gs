// ================================================================
// 구글 드라이브 업로드 웹앱
// ================================================================

const UPLOAD_FOLDER_ID = '<Drive 폴더 ID>';
const SECRET_KEY = PropertiesService.getScriptProperties().getProperty('SECRET_KEY');
// 이 스크립트를 배포하는 기관의 이름. 앱(VITE_ORG_NAME)과 정확히 같은 이름으로 바꿔야 업로드가 허용됩니다.
const OUR_ORG_NAME = '(기관명)';

function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);

    if (params.secret !== SECRET_KEY) {
      return json({ error: '인증 실패' });
    }

    // ── Drive .txt 텍스트 파일 읽기 ──────────────────────────────
    if (params.action === 'getFileText') {
      try {
        const file = DriveApp.getFileById(params.fileId);
        // 파일 ID만 알면 다른 기관의 파일까지 읽을 수 있으므로, 요청한 기관의 폴더 안 파일만 읽는다
        if (!isFileInOrgFolder_(file, params.orgName)) return json({ error: '이 기관의 파일이 아닙니다' });
        const text = file.getBlob().getDataAsString('UTF-8');
        return json({ text: text });
      } catch (err) {
        return json({ error: 'getFileText 실패: ' + err.message });
      }
    }

    // ── 동의서 PDF 내려받기 (앱이 직원의 권한을 확인한 뒤 대신 열어 줄 때 사용) ──
    // 요청: { secret, action: 'getFileBase64', fileId, orgName }
    // 해당 기관의 '동의서' 폴더 안 파일만 내보낸다 (파일 ID만 알면 다른 파일을 읽는 것을 막는다)
    if (params.action === 'getFileBase64') {
      try {
        const consentFolder = findConsentFolder_(params.orgName);
        if (!consentFolder) return json({ error: '동의서 폴더를 찾지 못했습니다' });
        const file = DriveApp.getFileById(params.fileId);
        let inFolder = false;
        const parents = file.getParents();
        while (parents.hasNext()) {
          if (parents.next().getId() === consentFolder.getId()) { inFolder = true; break; }
        }
        if (!inFolder) return json({ error: '동의서 폴더의 파일이 아닙니다' });
        if (file.getSize() > CONSENT_MAX_BYTES) return json({ error: '파일이 너무 커서 열 수 없습니다' });
        return json({
          data: Utilities.base64Encode(file.getBlob().getBytes()),
          mimeType: file.getMimeType(),
          name: file.getName()
        });
      } catch (err) {
        return json({ error: 'getFileBase64 실패: ' + err.message });
      }
    }

    // ── 스캔 PDF OCR 텍스트 추출 ─────────────────────────────────
    // 요청: { secret, action: 'extractOcrText', fileId }
    if (params.action === 'extractOcrText') {
      var docId = null;
      try {
        // 요청한 기관의 폴더 안 파일만 변환한다 (다른 기관의 파일을 복사·내보내기 못하게)
        if (!isFileInOrgFolder_(DriveApp.getFileById(params.fileId), params.orgName)) {
          return json({ error: '이 기관의 파일이 아닙니다' });
        }
        var oauthToken = ScriptApp.getOAuthToken();
        var copyRes = UrlFetchApp.fetch(
          'https://www.googleapis.com/drive/v3/files/' + params.fileId + '/copy',
          {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + oauthToken, 'Content-Type': 'application/json' },
            payload: JSON.stringify({ name: '_ocr_tmp_' + params.fileId, mimeType: 'application/vnd.google-apps.document' }),
            muteHttpExceptions: true
          }
        );
        var copyData = JSON.parse(copyRes.getContentText());
        if (!copyData.id) return json({ error: 'OCR 변환 실패: ' + JSON.stringify(copyData) });
        docId = copyData.id;
        var exportRes = UrlFetchApp.fetch(
          'https://www.googleapis.com/drive/v3/files/' + docId + '/export?mimeType=text/plain',
          { headers: { 'Authorization': 'Bearer ' + oauthToken }, muteHttpExceptions: true }
        );
        var text = exportRes.getContentText('UTF-8');
        DriveApp.getFileById(docId).setTrashed(true);
        return json({ text: text });
      } catch (err) {
        if (docId) { try { DriveApp.getFileById(docId).setTrashed(true); } catch(e) {} }
        return json({ error: 'OCR 실패: ' + err.message });
      }
    }

    const blob = Utilities.newBlob(
      Utilities.base64Decode(params.data),
      params.mimeType,
      params.name
    );

    // ── 기관별 작업 폴더 결정 ────────────────────────────────────
    const rootFolder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
    let workingFolder = rootFolder;

    if (params.orgName && params.orgName !== OUR_ORG_NAME) {
      const extIter = rootFolder.getFoldersByName('[타기관 백업]');
      const extFolder = extIter.hasNext()
        ? extIter.next()
        : rootFolder.createFolder('[타기관 백업]');

      const orgIter = extFolder.getFoldersByName(params.orgName);
      workingFolder = orgIter.hasNext()
        ? orgIter.next()
        : extFolder.createFolder(params.orgName);
    }

    // ── folderName 하위 폴더 ──────────────────────────────────────
    let targetFolder = workingFolder;
    if (params.folderName) {
      const existing = workingFolder.getFoldersByName(params.folderName);
      targetFolder = existing.hasNext()
        ? existing.next()
        : workingFolder.createFolder(params.folderName);
    }

    // 비공개 폴더 자체가 링크 공유면 안의 파일이 그 공유를 물려받아 파일 단위로는 끌 수 없다 → 폴더부터 비공개로 유지
    if (params.folderName && PRIVATE_FOLDERS.indexOf(params.folderName) !== -1) {
      try {
        if (targetFolder.getSharingAccess() !== DriveApp.Access.PRIVATE) {
          targetFolder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        }
      } catch (folderErr) {
        Logger.log('폴더 비공개 전환 실패 (무시): ' + folderErr.message);
      }
    }

    const file = targetFolder.createFile(blob);

    // 공유 규칙은 isPrivateUpload_ 참고: 서버로만 읽는 파일·보관용 파일은 비공개, 화면에서 링크로 여는 파일만 링크 공유
    try {
      if (isPrivateUpload_(params.folderName, params.mimeType, params.name)) {
        file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      } else {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      }
    } catch (sharingErr) {
      Logger.log('setSharing 실패 (무시): ' + sharingErr.message);
    }

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

// ================================================================
// 업로드 파일 공유 규칙
//  · 화면에서 링크로 직접 여는 파일(가계도 그림, PDF 원본 등)만 '링크가 있는 모든 사용자 보기' (상담 녹음은 비공개)
//  · 앱이 서버(getFileText)로만 읽는 파일(텍스트·JSON)과 업로드 보관용 엑셀 원본은 비공개
//    (getFileText·OCR은 이 스크립트의 소유자 권한으로 읽으므로 비공개여도 동작한다)
//  · 폴더를 추가하려면 PRIVATE_FOLDERS 에 이름을 넣는다.
// ================================================================
const PRIVATE_FOLDERS = ['AI 기능 동의서', 'DB백업', '구글 드라이브 업로드_복순이', '대상자관리', '상담기록', '상담녹음'];
const PRIVATE_MIME_TYPES = ['text/plain', 'application/json'];

function isPrivateUpload_(folderName, mimeType, fileName) {
  if (folderName && PRIVATE_FOLDERS.indexOf(folderName) !== -1) return true;
  if (mimeType && PRIVATE_MIME_TYPES.indexOf(mimeType) !== -1) return true;
  return /\.(txt|json)$/i.test(fileName || '');
}

// ── 동의서 열람: 파일은 비공개로 두고 앱(drive-proxy)이 직원의 권한을 확인한 뒤 이 스크립트가 대신 읽어 준다 ──
const CONSENT_FOLDER_NAME = 'AI 기능 동의서';
const CONSENT_MAX_BYTES = 15 * 1024 * 1024;

// ── 파일이 요청한 기관의 폴더 안에 있는지 확인 (getFileText·extractOcrText 전용) ──
// 우리 기관 폴더는 업로드 루트이고 다른 기관은 루트/[타기관 백업]/기관명 이므로,
// 우리 기관을 확인할 때는 '[타기관 백업]' 폴더를 거쳐 올라온 경로를 인정하지 않는다.
const EXTERNAL_ORG_FOLDER_NAME = '[타기관 백업]';

function findOrgBaseFolder_(orgName) {
  const root = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
  if (orgName === OUR_ORG_NAME) return root;
  const ext = root.getFoldersByName(EXTERNAL_ORG_FOLDER_NAME);
  if (!ext.hasNext()) return null;
  const org = ext.next().getFoldersByName(orgName);
  return org.hasNext() ? org.next() : null;
}

function isFileInOrgFolder_(file, orgName) {
  if (!orgName) return false;
  const base = findOrgBaseFolder_(orgName);
  if (!base) return false;
  const baseId = base.getId();
  const ours = (orgName === OUR_ORG_NAME);
  const seen = {};
  const queue = [];
  const first = file.getParents();
  while (first.hasNext()) queue.push({ folder: first.next(), depth: 0 });
  while (queue.length) {
    const cur = queue.shift();
    const id = cur.folder.getId();
    if (seen[id]) continue;
    seen[id] = true;
    if (id === baseId) return true;
    if (ours && cur.folder.getName() === EXTERNAL_ORG_FOLDER_NAME) continue; // 다른 기관 사본 경로는 인정하지 않음
    if (cur.folder.getName() === BACKUP_FOLDER_NAME) return false; // [백업] 폴더(전체 기관 DB 백업)는 어떤 기관도 읽을 수 없음
    if (cur.depth >= 8) continue;
    const up = cur.folder.getParents();
    while (up.hasNext()) queue.push({ folder: up.next(), depth: cur.depth + 1 });
  }
  return false;
}

// 기관별 '동의서' 폴더 찾기 (없으면 만들지 않고 null)
function findConsentFolder_(orgName) {
  let base = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
  if (orgName && orgName !== OUR_ORG_NAME) {
    const ext = base.getFoldersByName('[타기관 백업]');
    if (!ext.hasNext()) return null;
    const org = ext.next().getFoldersByName(orgName);
    if (!org.hasNext()) return null;
    base = org.next();
  }
  const it = base.getFoldersByName(CONSENT_FOLDER_NAME);
  return it.hasNext() ? it.next() : null;
}

// ── 이미 올라간 파일을 한 번에 비공개로 바꾸기 (Apps Script 편집기에서 직접 실행) ──
//  1) previewLockSensitiveFiles : 몇 개가 바뀔지 세기만 한다 (아무것도 바꾸지 않음)
//  2) lockSensitiveFiles        : 실제로 비공개로 바꾼다. 시간이 모자라면 '이어서 실행' 안내가 나오니 한 번 더 실행
//  결과는 실행 로그(보기 → 로그)에 나온다. 여러 번 실행해도 안전하다.
const LOCK_MAX_RUNTIME_MS = 5 * 60 * 1000;

function walkLock_(folder, apply, stat, deadline) {
  const folderName = folder.getName();
  // 비공개 폴더 자체가 링크 공유이면 안의 파일이 공유를 물려받아 파일 단위로는 끌 수 없으므로 폴더부터 비공개로 바꾼다
  if (PRIVATE_FOLDERS.indexOf(folderName) !== -1 && folder.getSharingAccess() !== DriveApp.Access.PRIVATE) {
    stat.folderTargets++;
    if (apply) {
      try {
        folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        stat.folderLocked++;
      } catch (err) {
        stat.folderFailed++;
        stat.failedNames.push('[폴더] ' + folderName + ' ← ' + err.message);
      }
    }
  }
  const files = folder.getFiles();
  while (files.hasNext()) {
    if (Date.now() > deadline) { stat.timedOut = true; return; }
    const f = files.next();
    stat.scanned++;
    if (!isPrivateUpload_(folderName, f.getMimeType(), f.getName())) continue;
    if (f.getSharingAccess() === DriveApp.Access.PRIVATE) { stat.already++; continue; }
    stat.targets++;
    if (apply) {
      try {
        f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        stat.locked++;
      } catch (err) {
        stat.failed++;
        stat.failedNames.push(folderName + '/' + f.getName() + ' ← ' + err.message);
      }
    }
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    if (stat.timedOut) return;
    const sub = subs.next();
    if (sub.getName() === BACKUP_FOLDER_NAME) continue; // DB 백업 폴더는 이미 비공개라 건너뜀
    walkLock_(sub, apply, stat, deadline);
  }
}

function runLockSensitive_(apply) {
  const stat = { scanned: 0, targets: 0, locked: 0, already: 0, failed: 0, folderTargets: 0, folderLocked: 0, folderFailed: 0, failedNames: [], timedOut: false };
  walkLock_(DriveApp.getFolderById(UPLOAD_FOLDER_ID), apply, stat, Date.now() + LOCK_MAX_RUNTIME_MS);
  const lines = [
    (apply ? '[비공개 전환]' : '[미리보기 — 아무것도 바꾸지 않았습니다]'),
    '검사한 파일: ' + stat.scanned,
    '이미 비공개: ' + stat.already,
    (apply ? '이번에 비공개로 바꾼 폴더: ' + stat.folderLocked : '비공개로 바뀔 폴더: ' + stat.folderTargets),
    (apply ? '이번에 비공개로 바꾼 파일: ' + stat.locked : '비공개로 바뀔 파일: ' + stat.targets),
    '실패: ' + (stat.failed + stat.folderFailed)
  ];
  if (stat.failedNames.length) lines.push('실패 목록(최대 20개): ' + stat.failedNames.slice(0, 20).join(', '));
  if (stat.timedOut) lines.push('※ 시간이 모자라 중간에 멈췄습니다. 같은 함수를 한 번 더 실행하세요.');
  else lines.push('끝까지 검사했습니다.');
  Logger.log(lines.join('\n'));
  return stat;
}

function previewLockSensitiveFiles() { runLockSensitive_(false); }
function lockSensitiveFiles() { runLockSensitive_(true); }

// ── 비공개 전환에 실패하는 파일의 원인 확인 (Apps Script 편집기에서 직접 실행, 결과는 로그에 나옴) ──
// 'AI 기능 동의서' 폴더에서 파일 3개를 골라 소유자·공유 드라이브 여부·공유 가능 여부·실제 오류 메시지를 보여준다.
function diagnoseSharing() {
  const it = DriveApp.getFolderById(UPLOAD_FOLDER_ID).getFoldersByName('AI 기능 동의서');
  if (!it.hasNext()) { Logger.log('AI 기능 동의서 폴더를 찾지 못했습니다'); return; }
  const folder = it.next();
  const owner = function (x) { try { return x.getOwner() ? x.getOwner().getEmail() : '(없음 — 공유 드라이브이거나 소유자 없음)'; } catch (err) { return '확인 실패: ' + err.message; } };
  Logger.log('폴더 소유자: ' + owner(folder) + ' / 폴더 접근: ' + folder.getSharingAccess());
  const files = folder.getFiles();
  let n = 0;
  while (files.hasNext() && n < 3) {
    const f = files.next();
    n++;
    const lines = ['── ' + f.getName(), '   소유자: ' + owner(f), '   접근: ' + f.getSharingAccess() + ' / 권한: ' + f.getSharingPermission()];
    try {
      const res = UrlFetchApp.fetch(
        'https://www.googleapis.com/drive/v3/files/' + f.getId() + '?supportsAllDrives=true&fields=driveId,ownedByMe,capabilities(canShare,canChangeSecurityUpdateEnabled),permissions(type,role,emailAddress)',
        { headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
      );
      lines.push('   Drive 정보: ' + res.getContentText().replace(/\s+/g, ' ').slice(0, 400));
    } catch (err) { lines.push('   Drive 정보 조회 실패: ' + err.message); }
    try {
      f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      lines.push('   비공개 전환: 성공');
    } catch (err) { lines.push('   비공개 전환 실패: ' + err.message); }
    Logger.log(lines.join('\n'));
  }
}

function doGet() {
  return json({ status: 'ok' });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// DB 백업 (Supabase → Google Drive)
//
//  · 실행할 때마다 [백업] 폴더 아래에 backup_YYYY-MM-DD_HH-mm 폴더를 만들고
//    테이블별 JSON 파일(clients.json …)을 저장합니다.
//  · 목록(BACKUP_TABLES)에 없는 새 테이블도 자동으로 찾아서 함께 백업합니다.
//  · 로그인 사용자(auth_users.json)와 테이블 구조(_openapi_schema.json)도 함께 저장합니다.
//  · 실행 시간(6분 제한)이 모자라면 1분 뒤 자동으로 이어서 실행합니다.
//  · 건수 검증: 서버가 알려주는 전체 건수와 실제로 받은 건수를 비교합니다.
//  · 하나라도 실패/누락되면 폴더 이름 끝에 _INCOMPLETE 가 붙고,
//    그 경우에는 이전의 정상 백업을 절대 삭제하지 않습니다.
//  · 폴더 안의 _manifest.json 에 테이블별 건수와 검증 결과가 기록됩니다.
//
// 필요한 스크립트 속성: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// 선택 스크립트 속성  : BACKUP_NOTIFY_EMAIL (문제 발생 시 알림 받을 메일 주소)
//
// 백업되지 않는 것: 테이블 구조 외의 DB 설정(RLS 정책·함수·트리거 정의)은 REST로 읽을 수 없습니다.
//                   → 레포의 supabase/migrations 폴더와 scripts/backup-db.ps1(supabase db dump)로 별도 보관하세요.
// ================================================================

const BACKUP_FOLDER_NAME = '[백업]';
const BACKUP_KEEP_COUNT = 104;                   // 보관할 정상 백업 개수 (매주 실행이면 약 2년치)
const BACKUP_PAGE_SIZE = 500;                    // 한 번에 가져올 행 수 (Supabase 서버 한도 1000 이하)
const BACKUP_MAX_RUNTIME_MS = 5 * 60 * 1000;     // 한 번 실행 시간 (Apps Script 제한 6분 전에 멈추고 이어서 실행)
const BACKUP_MAX_CONTINUATIONS = 20;             // 이어서 실행하는 최대 횟수
const BACKUP_RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;  // 이어하기 유효 시간 (이보다 오래된 미완성 백업은 포기)
const BACKUP_PART_MAX_CHARS = 12 * 1000 * 1000;  // 파일 하나의 최대 크기(글자 수). 넘으면 _part01, _part02 로 분할
const BACKUP_INCLUDE_AUTH_USERS = true;          // 로그인 사용자(auth.users) 백업 여부
const BACKUP_AUTO_INCLUDE_NEW_TABLES = true;     // 목록에 없는 새 테이블도 자동 백업

// 행이 커서 한 번에 많이 가져오면 안 되는 테이블은 행 수를 줄여서 가져옵니다.
const BACKUP_PAGE_OVERRIDES = {
  clients: 200,
  activity_logs: 200,
  audit_log: 50,
  files: 200,
  manuals: 50,
  manual_sources: 50,
  ai_reports: 100,
  closure_reports: 100,
  consent_audit_logs: 50
};

// 정렬 기준 (기본은 id). id 컬럼이 없는 테이블만 따로 지정합니다.
// 정렬이 있어야 페이지를 넘길 때 행이 겹치거나 빠지지 않습니다.
const BACKUP_ORDER = {
  companion_ack: 'session_id.asc,acked_at.asc',
  companion_hidden_sessions: 'session_id.asc,hidden_at.asc'
};

// 우선순위 순서로 백업할 테이블 (중요한 테이블이 앞쪽, 용량이 큰 로그가 뒤쪽)
// 여기에 없는 테이블은 자동으로 뒤에 추가됩니다. 새 테이블을 만들면 여기에도 적어 두면 좋습니다.
const BACKUP_TABLES = [
  'organizations', 'profiles', 'user_roles',
  'clients', 'activity_logs', 'provisions', 'goals',
  'care_plan_action_links', 'closure_reports', 'worker_handovers',
  'consent_audit_logs',
  'files', 'manuals', 'manual_sources', 'ai_reports',
  'companion_ack', 'companion_hidden_sessions',
  'access_log', 'audit_log'
];

// 일부러 백업하지 않는 테이블
const BACKUP_EXCLUDED = [];

// ── 서버에서 한 페이지 가져오기 (일시 오류는 최대 3회 재시도) ─────────
function fetchPage_(url, serviceKey, wantCount) {
  const headers = {
    'apikey': serviceKey,
    'Authorization': 'Bearer ' + serviceKey
  };
  if (wantCount) headers['Prefer'] = 'count=exact';   // 응답 헤더로 전체 건수를 받아 검증에 사용

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
      const code = res.getResponseCode();
      if (code === 200 || code === 206) {
        return { ok: true, code: code, text: res.getContentText(), headers: res.getHeaders() };
      }
      if (code >= 500 || code === 429) {          // 서버 쪽 일시 오류 → 잠시 후 재시도
        lastError = 'HTTP ' + code;
        Utilities.sleep(1500 * attempt);
        continue;
      }
      return { ok: false, code: code, text: res.getContentText() };  // 4xx 는 재시도해도 소용없음
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      Utilities.sleep(1500 * attempt);
    }
  }
  return { ok: false, code: 0, text: lastError };
}

// 응답 헤더 Content-Range ("0-499/1234") 에서 전체 건수 읽기
function parseTotal_(headers) {
  if (!headers) return null;
  for (const k in headers) {
    if (String(k).toLowerCase() === 'content-range') {
      const m = /\/(\d+)\s*$/.exec(String(headers[k]));
      return m ? Number(m[1]) : null;
    }
  }
  return null;
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function lockFile_(ctx, fileOrFolder) {
  try {
    fileOrFolder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (err) {
    ctx.sharingFailures++;
  }
}

function writePart_(ctx, table, partNo, rows) {
  const file = ctx.folder.createFile(
    table + '_part' + pad2_(partNo) + '.json',
    JSON.stringify(rows),
    'application/json'
  );
  lockFile_(ctx, file);
  return file;
}

// ── 테이블 하나를 백업. 시간이 모자라면 중간에 멈추고 이어할 위치를 돌려줌 ──
function backupTable_(ctx, table, resume, isExtra) {
  const result = resume ? resume.result : { table: table, status: 'ok', rows: 0, expected: null, parts: 0, order: null, note: '', extra: !!isExtra };
  const pageSize = BACKUP_PAGE_OVERRIDES[table] || BACKUP_PAGE_SIZE;
  let order = resume ? resume.order : ((BACKUP_ORDER[table] !== undefined) ? BACKUP_ORDER[table] : 'id.asc');
  let from = resume ? resume.offset : 0;
  let partNo = resume ? resume.partNo : 0;
  if (resume) result.resumed = true;
  const baseUrl = ctx.supUrl + '/rest/v1/' + table + '?select=*';

  let buffer = [];
  let bufferChars = 0;
  let firstPartFile = null;
  const seenIds = {};
  let duplicates = 0;

  while (true) {
    if (Date.now() > ctx.deadline) {                      // 시간이 모자람 → 지금까지 저장하고 이어서 실행
      if (buffer.length > 0) { partNo++; writePart_(ctx, table, partNo, buffer); buffer = []; }
      result.parts = partNo;
      result.order = order;
      return { paused: true, cur: { table: table, offset: from, partNo: partNo, order: order, result: result } };
    }

    const paging = '&limit=' + pageSize + '&offset=' + from;
    let r = fetchPage_(baseUrl + (order ? '&order=' + order : '') + paging, ctx.key, from === 0);

    // 정렬 컬럼이 없는 테이블이면 정렬 없이 다시 시도 (건수 검증으로 보완)
    if (!r.ok && from === 0 && r.code === 400 && order) {
      order = null;
      result.note += '정렬 컬럼 없음→정렬 없이 백업; ';
      r = fetchPage_(baseUrl + paging, ctx.key, true);
    }

    if (!r.ok) {
      if (r.code === 404 && from === 0) {                 // 존재하지 않는 테이블
        result.status = 'skipped';
        result.note += '테이블 없음(404); ';
        break;
      }
      result.status = 'failed';
      result.note += 'HTTP ' + r.code + ' ' + String(r.text).slice(0, 160) + '; ';
      break;
    }

    let page;
    try { page = JSON.parse(r.text); } catch (err) { page = null; }
    if (!Array.isArray(page)) {
      result.status = 'failed';
      result.note += '응답 형식 오류; ';
      break;
    }

    if (from === 0) result.expected = parseTotal_(r.headers);

    for (let i = 0; i < page.length; i++) {
      const row = page[i];
      if (row && row.id !== undefined && row.id !== null) {
        if (seenIds[row.id]) duplicates++; else seenIds[row.id] = 1;
      }
      buffer.push(row);
    }
    bufferChars += r.text.length;
    result.rows += page.length;

    if (bufferChars >= BACKUP_PART_MAX_CHARS) {            // 너무 커지면 파일을 나눠 저장
      partNo++;
      const pf = writePart_(ctx, table, partNo, buffer);
      if (partNo === 1) firstPartFile = pf;
      buffer = [];
      bufferChars = 0;
    }

    if (page.length === 0) break;
    if (result.expected !== null && result.rows >= result.expected) break;
    if (page.length < pageSize) break;
    from += pageSize;
  }

  // 검증: 서버가 말한 전체 건수보다 적게 받았거나 같은 행이 겹치면 불완전 처리
  if (result.status === 'ok') {
    if (result.expected !== null && result.rows < result.expected) {
      result.status = 'partial';
      result.note += '서버 전체 ' + result.expected + '건 중 ' + result.rows + '건만 받음; ';
    }
    if (duplicates > 0) {
      result.status = 'partial';
      result.note += '중복 행 ' + duplicates + '건; ';
    }
  }

  // 남은 데이터 저장 (빈 테이블도 빈 배열 파일로 남겨서 "비어 있었다"는 기록을 보존)
  if (result.status !== 'skipped' && (buffer.length > 0 || partNo === 0)) {
    if (!(result.status === 'failed' && result.rows === 0)) {
      partNo++;
      const pf = writePart_(ctx, table, partNo, buffer);
      if (partNo === 1) firstPartFile = pf;
    }
  }
  if (partNo === 1 && firstPartFile && !result.resumed) {
    try { firstPartFile.setName(table + '.json'); } catch (err) { /* 이름 변경 실패는 무시 */ }
  }
  result.parts = partNo;
  result.order = order;
  return { paused: false, result: result };
}

// ── 로그인 사용자(auth.users) 백업: 일반 테이블이 아니라 Auth 관리 API로 읽음 ──
function backupAuthUsers_(ctx) {
  const result = { table: 'auth_users', status: 'ok', rows: 0, expected: null, parts: 0, order: null, note: '', extra: false };
  const PER_PAGE = 1000;
  const users = [];
  const seen = {};
  let duplicates = 0;
  for (let page = 1; page <= 200; page++) {
    const r = fetchPage_(ctx.supUrl + '/auth/v1/admin/users?page=' + page + '&per_page=' + PER_PAGE, ctx.key, false);
    if (!r.ok) {
      result.status = 'failed';
      result.note += 'HTTP ' + r.code + ' ' + String(r.text).slice(0, 160) + '; ';
      break;
    }
    let body;
    try { body = JSON.parse(r.text); } catch (err) { body = null; }
    const list = Array.isArray(body) ? body : (body && Array.isArray(body.users) ? body.users : null);
    if (!list) {
      result.status = 'failed';
      result.note += '응답 형식 오류; ';
      break;
    }
    list.forEach(function (u) {
      if (u && u.id) { if (seen[u.id]) duplicates++; else seen[u.id] = 1; }
      users.push(u);
    });
    if (body && typeof body.total === 'number') result.expected = body.total;
    if (list.length < PER_PAGE) break;
  }
  if (result.status === 'ok') {
    if (duplicates > 0) { result.status = 'partial'; result.note += '중복 ' + duplicates + '건; '; }
    if (result.expected !== null && users.length < result.expected) {
      result.status = 'partial';
      result.note += '전체 ' + result.expected + '명 중 ' + users.length + '명만 받음; ';
    }
  }
  if (result.status === 'ok' || users.length > 0) {
    lockFile_(ctx, ctx.folder.createFile('auth_users.json', JSON.stringify(users), 'application/json'));
    result.parts = 1;
  }
  result.rows = users.length;
  return { paused: false, result: result };
}

// ── 서버에 있는 테이블 목록과 구조(OpenAPI) 가져오기 (실패하면 names=null) ──
function listApiTables_(supUrl, serviceKey) {
  try {
    const res = UrlFetchApp.fetch(supUrl + '/rest/v1/', {
      headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return { names: null, specText: null };
    const text = res.getContentText();
    const spec = JSON.parse(text);
    const defs = spec.definitions || (spec.components && spec.components.schemas) || null;
    if (!defs) return { names: null, specText: text };
    return { names: Object.keys(defs), specText: text };
  } catch (err) {
    return { names: null, specText: null };
  }
}

function getBackupRoot_() {
  const rootFolder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
  const it = rootFolder.getFoldersByName(BACKUP_FOLDER_NAME);
  return it.hasNext() ? it.next() : rootFolder.createFolder(BACKUP_FOLDER_NAME);
}

function notify_(subject, body) {
  const to = PropertiesService.getScriptProperties().getProperty('BACKUP_NOTIFY_EMAIL');
  if (!to) {
    Logger.log('[알림 생략 — BACKUP_NOTIFY_EMAIL 미설정] ' + subject);
    return;
  }
  try {
    MailApp.sendEmail(to, '[사례관리 DB 백업] ' + subject, body);
  } catch (err) {
    Logger.log('알림 메일 발송 실패: ' + err.message);
  }
}

// ── 이어서 실행하기 위한 상태 저장/복원 ──────────────────────────────
function saveState_(stateFile, state) {
  stateFile.setContent(JSON.stringify(state));
}

// 이어하기 트리거 정리. 트리거 권한(script.scriptapp)이 없어도 백업 자체는 계속 진행되도록 오류를 삼킴
function deleteContinuationTriggers_() {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'doBackupContinue') ScriptApp.deleteTrigger(t);
    });
  } catch (err) {
    Logger.log('⚠ 이어하기 트리거 정리를 건너뜁니다 (권한 없음 — 백업은 계속 진행): ' + err.message);
  }
}

// 진행 중이던 백업이 있으면 불러옴. 너무 오래됐으면 포기(INCOMPLETE 처리).
function loadActiveRun_(props) {
  const raw = props.getProperty('BACKUP_ACTIVE');
  if (!raw) return null;
  try {
    const active = JSON.parse(raw);
    const folder = DriveApp.getFolderById(active.folderId);
    if (Date.now() - active.startedAt > BACKUP_RESUME_WINDOW_MS) {
      folder.setName(folder.getName().replace(/_진행중$/, '') + '_INCOMPLETE');
      props.deleteProperty('BACKUP_ACTIVE');
      notify_('오래된 미완성 백업 포기', '이어하기 유효 시간이 지나 ' + folder.getName() + ' 을(를) 불완전 백업으로 표시했습니다.');
      return null;
    }
    const it = folder.getFilesByName('_state.json');
    if (!it.hasNext()) return null;
    const stateFile = it.next();
    return { folder: folder, stateFile: stateFile, state: JSON.parse(stateFile.getBlob().getDataAsString('UTF-8')) };
  } catch (err) {
    Logger.log('이어하기 정보를 읽지 못해 새로 시작합니다: ' + err.message);
    props.deleteProperty('BACKUP_ACTIVE');
    return null;
  }
}

// 새 백업 시작: 폴더 생성, 백업할 테이블 목록 확정, 테이블 구조 저장
function startRun_(props, supUrl, serviceKey) {
  const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd_HH-mm');
  const bkDir = getBackupRoot_();
  const folder = bkDir.createFolder('backup_' + stamp + '_진행중');
  const ctx0 = { sharingFailures: 0 };
  lockFile_(ctx0, folder);

  const found = listApiTables_(supUrl, serviceKey);
  const plan = BACKUP_TABLES.slice();
  if (BACKUP_INCLUDE_AUTH_USERS) plan.splice(3, 0, 'auth_users');   // organizations, profiles, user_roles 다음
  const extras = [];
  if (BACKUP_AUTO_INCLUDE_NEW_TABLES && found.names) {
    found.names.forEach(function (name) {
      if (plan.indexOf(name) === -1 && BACKUP_EXCLUDED.indexOf(name) === -1) { plan.push(name); extras.push(name); }
    });
  }
  if (found.specText) lockFile_(ctx0, folder.createFile('_openapi_schema.json', found.specText, 'application/json'));

  const state = {
    stamp: stamp,
    startedAt: Date.now(),
    plan: plan,
    extras: extras,
    discoveryOk: found.names !== null,
    schemaSaved: !!found.specText,
    idx: 0,
    cur: null,
    results: [],
    continuations: 0,
    sharingFailures: ctx0.sharingFailures
  };
  const stateFile = folder.createFile('_state.json', JSON.stringify(state), 'application/json');
  lockFile_(ctx0, stateFile);
  state.sharingFailures = ctx0.sharingFailures;
  props.setProperty('BACKUP_ACTIVE', JSON.stringify({ folderId: folder.getId(), startedAt: state.startedAt }));
  return { folder: folder, stateFile: stateFile, state: state };
}

// ── 오래된 정상 백업 정리 (이번 백업이 정상일 때만 호출) ──────────────
function pruneOldBackups_(bkDir) {
  const good = [];
  const folders = bkDir.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    const name = f.getName();
    if (name.indexOf('backup_') === 0 && !/_INCOMPLETE$/.test(name) && !/_진행중$/.test(name)) good.push(f);
  }
  good.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });   // 이름(날짜) 최신순
  for (let i = BACKUP_KEEP_COUNT; i < good.length; i++) good[i].setTrashed(true);

  // 예전 방식(단일 JSON 파일)으로 만든 백업은 35일이 지나면 정리
  const cutoff = Date.now() - 35 * 24 * 3600 * 1000;
  const files = bkDir.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const n = file.getName();
    if (n.indexOf('backup_') === 0 && /\.json$/.test(n) && file.getDateCreated().getTime() < cutoff) file.setTrashed(true);
  }
}

// ── 모든 테이블이 끝났을 때: 매니페스트 작성, 폴더 이름 확정, 정리, 알림 ──
function finalizeRun_(props, run) {
  const state = run.state;
  const folder = run.folder;
  const bkDir = getBackupRoot_();
  const results = state.results;

  const problems = results.filter(function (r) {
    return !r.extra && (r.status === 'failed' || r.status === 'partial' || r.status === 'not_run');
  });
  const warnings = [];
  results.forEach(function (r) {
    if (r.status === 'skipped') warnings.push(r.table + ': 존재하지 않는 테이블이라 건너뜀 (BACKUP_TABLES 에서 빼도 됩니다)');
    else if (r.extra && r.status !== 'ok') warnings.push(r.table + ': 자동 추가된 테이블 백업 문제 [' + r.status + '] ' + r.note);
  });
  if (state.extras.length > 0) warnings.push('목록에 없어 자동으로 백업된 테이블: ' + state.extras.join(', ') + ' → BACKUP_TABLES 에 추가해 두세요');
  if (!state.discoveryOk) warnings.push('새 테이블 자동 탐색을 할 수 없었습니다 (BACKUP_TABLES 목록만 백업됨)');
  if (!state.schemaSaved) warnings.push('테이블 구조(_openapi_schema.json)를 저장하지 못했습니다');
  if (state.sharingFailures > 0) warnings.push('비공개 설정에 실패한 파일/폴더 ' + state.sharingFailures + '개 — Drive에서 공유 상태를 확인하세요');
  try {
    if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE) warnings.push('백업 폴더가 비공개가 아닙니다 — Drive에서 공유 설정을 확인하세요');
  } catch (err) { /* 확인 불가는 무시 */ }

  const complete = problems.length === 0;
  const manifest = {
    createdAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - state.startedAt) / 1000),
    runs: state.continuations + 1,
    complete: complete,
    tables: results,
    autoIncluded: state.extras,
    warnings: warnings
  };
  const mf = folder.createFile('_manifest.json', JSON.stringify(manifest, null, 2), 'application/json');
  lockFile_({ sharingFailures: 0 }, mf);
  try { run.stateFile.setTrashed(true); } catch (err) { /* 무시 */ }

  const finalName = 'backup_' + state.stamp + (complete ? '' : '_INCOMPLETE');
  folder.setName(finalName);
  props.deleteProperty('BACKUP_ACTIVE');
  if (complete) pruneOldBackups_(bkDir);

  const totalRows = results.reduce(function (s, r) { return s + r.rows; }, 0);
  Logger.log((complete ? '✅ 백업 완료' : '❌ 백업 불완전') + ': ' + finalName + ' — ' + results.length + '개 항목, 총 ' + totalRows + '건, ' + manifest.durationSec + '초, 실행 ' + manifest.runs + '회');
  warnings.forEach(function (w) { Logger.log('⚠ ' + w); });

  if (!complete || warnings.length > 0) {
    const lines = [];
    lines.push(complete ? '백업은 완료되었지만 확인할 사항이 있습니다.' : '백업이 불완전합니다. 이전 정상 백업은 삭제하지 않았습니다.');
    lines.push('폴더: ' + finalName);
    problems.forEach(function (r) { lines.push('✗ ' + r.table + ' [' + r.status + '] ' + r.note); });
    warnings.forEach(function (w) { lines.push('⚠ ' + w); });
    notify_(complete ? '확인 필요' : '백업 불완전', lines.join('\n'));
  }
}

// 더 이어서 실행할 수 없을 때: 남은 항목을 "미완료"로 기록하고 마감 준비
function closeRemaining_(state, reason) {
  if (state.cur) {
    state.cur.result.status = 'partial';
    state.cur.result.note += reason + '; ';
    state.results.push(state.cur.result);
    state.idx++;
    state.cur = null;
  }
  while (state.idx < state.plan.length) {
    const name = state.plan[state.idx];
    state.results.push({ table: name, status: 'not_run', rows: 0, expected: null, parts: 0, order: null, note: reason + '으로 실행되지 않음', extra: state.extras.indexOf(name) !== -1 });
    state.idx++;
  }
}

// ── 메인 실행 (트리거가 호출하거나 직접 실행). 미완성 백업이 있으면 이어서 진행 ──
function runBackup_() {
  const props = PropertiesService.getScriptProperties();
  const supUrl = (props.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  const serviceKey = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!supUrl || !serviceKey) {
    Logger.log('⚠ 스크립트 속성 미설정: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    notify_('백업 실패 — 설정 누락', 'SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 스크립트 속성이 없습니다.');
    return;
  }

  // 중복 실행 방지 (직접 실행과 트리거가 겹치는 경우)
  const runningSince = Number(props.getProperty('BACKUP_RUNNING_SINCE') || 0);
  if (runningSince && Date.now() - runningSince < 15 * 60 * 1000) {
    Logger.log('다른 백업이 실행 중이라 건너뜁니다.');
    return;
  }
  props.setProperty('BACKUP_RUNNING_SINCE', String(Date.now()));

  try {
    deleteContinuationTriggers_();
    let run = loadActiveRun_(props);
    if (run) Logger.log('이어서 실행합니다: backup_' + run.state.stamp + ' (' + run.state.idx + '/' + run.state.plan.length + ' 완료)');
    else run = startRun_(props, supUrl, serviceKey);

    const state = run.state;
    const ctx = {
      supUrl: supUrl,
      key: serviceKey,
      folder: run.folder,
      deadline: Date.now() + BACKUP_MAX_RUNTIME_MS,
      sharingFailures: 0
    };

    while (state.idx < state.plan.length) {
      const name = state.plan[state.idx];
      let out;
      try {
        if (name === 'auth_users') out = backupAuthUsers_(ctx);
        else out = backupTable_(ctx, name, (state.cur && state.cur.table === name) ? state.cur : null, state.extras.indexOf(name) !== -1);
      } catch (err) {
        out = { paused: false, result: { table: name, status: 'failed', rows: 0, expected: null, parts: 0, order: null, note: '예외: ' + err.message, extra: state.extras.indexOf(name) !== -1 } };
      }
      if (out.paused) { state.cur = out.cur; break; }
      state.cur = null;
      const r = out.result;
      state.results.push(r);
      state.idx++;
      Logger.log((r.status === 'ok' ? '✓ ' : (r.status === 'skipped' ? '- ' : '✗ ')) +
        r.table + ': ' + r.rows + '건' + (r.expected !== null ? ' / 서버 ' + r.expected + '건' : '') +
        ' [' + r.status + '] ' + r.note);
    }
    state.sharingFailures += ctx.sharingFailures;

    if (state.idx < state.plan.length) {
      // 시간이 모자라 아직 남음 → 이어서 실행 예약 (횟수 제한 초과 시 남은 항목을 미완료로 마감)
      if (state.continuations >= BACKUP_MAX_CONTINUATIONS) {
        closeRemaining_(state, '이어하기 횟수 초과');
        finalizeRun_(props, run);
      } else {
        let scheduled = true;
        try {
          ScriptApp.newTrigger('doBackupContinue').timeBased().after(60 * 1000).create();
        } catch (err) {
          scheduled = false;
          Logger.log('❌ 이어하기 트리거를 만들 수 없습니다 (권한 script.scriptapp 필요): ' + err.message);
        }
        if (scheduled) {
          state.continuations++;
          saveState_(run.stateFile, state);
          Logger.log('⏳ 시간이 모자라 1분 뒤 이어서 실행합니다 (' + state.idx + '/' + state.plan.length + ' 완료, 이어하기 ' + state.continuations + '회)');
        } else {
          closeRemaining_(state, '이어하기 트리거 권한 없음(script.scriptapp)');
          finalizeRun_(props, run);
        }
      }
    } else {
      finalizeRun_(props, run);
    }
  } catch (err) {
    Logger.log('❌ 백업 중 오류: ' + err.message);
    notify_('백업 오류', String(err && err.stack ? err.stack : err));
  } finally {
    props.deleteProperty('BACKUP_RUNNING_SINCE');
  }
}

// 트리거가 부르는 함수: 매주(또는 매일) 정해진 시간에 실행
function doBackup() { runBackup_(); }

// 시간이 모자라 이어서 실행할 때 자동으로 불리는 함수 (직접 실행할 필요 없음)
function doBackupContinue() { runBackup_(); }

// ── 최근 백업 상태 확인 (Drive를 열지 않고 로그로 보기) ───────────────
function showLatestBackup() {
  const bkDir = getBackupRoot_();
  const list = [];
  const folders = bkDir.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    if (f.getName().indexOf('backup_') === 0) list.push(f);
  }
  list.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  if (list.length === 0) { Logger.log('백업 폴더가 없습니다.'); return; }
  list.slice(0, 3).forEach(function (f) {
    Logger.log('── ' + f.getName());
    const it = f.getFilesByName('_manifest.json');
    if (!it.hasNext()) {
      const st = f.getFilesByName('_state.json');
      if (st.hasNext()) {
        const s = JSON.parse(st.next().getBlob().getDataAsString('UTF-8'));
        Logger.log('   진행 중 — ' + s.idx + '/' + s.plan.length + ' 완료, 이어하기 ' + s.continuations + '회');
      } else {
        Logger.log('   (매니페스트 없음 — 중간에 중단된 백업일 수 있음)');
      }
      return;
    }
    const m = JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
    Logger.log('   ' + (m.complete ? '정상' : '불완전') + ' · ' + m.createdAt + ' · ' + m.durationSec + '초 · 실행 ' + (m.runs || 1) + '회');
    m.tables.forEach(function (t) {
      Logger.log('   ' + t.table + ': ' + t.rows + '건' + (t.expected !== null ? ' / 서버 ' + t.expected : '') + ' [' + t.status + '] ' + (t.note || ''));
    });
    (m.warnings || []).forEach(function (w) { Logger.log('   ⚠ ' + w); });
  });
}

// ── 트리거 설정 (둘 중 하나만 실행하세요. 기존 doBackup 트리거는 자동으로 교체됩니다) ──
function clearBackupTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'doBackup') ScriptApp.deleteTrigger(t);
  });
}

function setupDailyBackupTrigger() {
  clearBackupTriggers_();
  ScriptApp.newTrigger('doBackup').timeBased().everyDays(1).atHour(2).create();
  Logger.log('✅ 트리거 등록 — 매일 02시경 자동 실행 (정상 백업 ' + BACKUP_KEEP_COUNT + '개 보관)');
}

function setupMondayBackupTrigger() {
  clearBackupTriggers_();
  ScriptApp.newTrigger('doBackup').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(2).create();
  Logger.log('✅ 트리거 등록 — 매주 월요일 02시경 자동 실행 (정상 백업 ' + BACKUP_KEEP_COUNT + '개 보관)');
}

function testDrive() {
  const folder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
  Logger.log(folder.getName());
}
