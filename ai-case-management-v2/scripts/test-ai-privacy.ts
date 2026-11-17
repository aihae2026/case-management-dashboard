// AI 로 보내는 참고 자료의 이름 제거·예시 선택, '오늘은 그만 보기' 날짜 계산 시험.
// 실행: bun scripts/test-ai-privacy.ts  (프로젝트 의존성 추가 없이 실행)
import { maskNamesInText, neutralizeHeaderName } from "../src/lib/ai-names";
import { buildHistory, sanitizeNoteForAi, selectSamples } from "../src/lib/ai-context";
import { hideAiNoticeToday, isAiNoticeHiddenToday, todayKst } from "../src/lib/ai-notice";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  → " + extra : ""}`);
}

const kim = { id: "1", name: "김가나", client_code: "JN0001" };
const kim6 = { id: "2", name: "김가나6", client_code: "JN0002" };
const park = { id: "3", name: "박다라", client_code: "JN0003" };
const noCode = { id: "4", name: "최마바", client_code: null };
const all = [kim, kim6, park, noCode];

// ── 첫 줄 이름 ───────────────────────────────────────────────
const header = "■ 2026년 김가나 당사자의 욕구/드러난 문제(재사정기반) : 식사 어려움\n\n· 전화 상담";
check("첫 줄 이름을 '대상자'로 바꾼다", neutralizeHeaderName(header).startsWith("■ 2026년 대상자 당사자의 욕구"), neutralizeHeaderName(header).split("\n")[0]);
check("번호로 된 첫 줄도 같은 모양", neutralizeHeaderName("■ 2026년 JN0001 당사자의 욕구").startsWith("■ 2026년 대상자 당사자의"));
check("첫 줄이 없는 글은 그대로", neutralizeHeaderName("전화 상담 진행") === "전화 상담 진행");

// ── 본문 속 이름 ─────────────────────────────────────────────
const m1 = maskNamesInText("김가나 어르신은 식사를 하셨고 김가나님께 연락드림", [kim]);
check("호칭·조사가 붙은 이름을 바꾼다", !m1.text.includes("김가나") && m1.count === 2, m1.text);
check("한글이 더 이어지면 다른 낱말로 보고 건드리지 않는다", maskNamesInText("김가나씨", [kim]).count === 1 && maskNamesInText("김가나정", [kim]).count === 0);
const m2 = maskNamesInText("김가나6 어르신 방문", [kim6]);
check("동명이인 숫자가 붙은 이름도 바꾼다", !m2.text.includes("김가나") && m2.count >= 1, m2.text);
check("번호가 없는 대상자 이름도 바꾼다", maskNamesInText("최마바 어르신 전화", [noCode]).count === 1);
check("성을 뺀 이름은 호칭이 붙었을 때만 바꾼다", maskNamesInText("가나 어르신", [kim]).count === 1 && maskNamesInText("가나 이야기", [kim]).count === 0);
check("이름이 없으면 그대로", maskNamesInText("식사 지원 안내", all).count === 0);

// ── 이전 상담 현황 ───────────────────────────────────────────
const thread = [
  { id: "a", created_at: "2026-10-01T03:00:00Z", note: "■ 2026년 김가나 당사자의 욕구 : 식사\n· 김가나 어르신 통화" },
  { id: "b", created_at: "2026-10-05T03:00:00Z", note: "■ 2026년 김가나 당사자의 욕구 : 병원\n· 병원 동행 논의" },
];
const hist = buildHistory(thread, [kim]);
check("이전 상담 현황에 이름이 남지 않는다", hist.every((h) => !h.text.includes("김가나")) && hist.length === 2, JSON.stringify(hist.map((h) => h.text.slice(0, 20))));
check("수정 중인 기록은 빼고 만든다", buildHistory(thread, [kim], "b").length === 1);
check("날짜는 한국시간", hist[0].date === "2026-10-01");
check("sanitizeNoteForAi: null 도 안전", sanitizeNoteForAi(null, [kim]) === "");

// ── 문체 예시 ────────────────────────────────────────────────
let s = selectSamples({ ownNotes: thread, otherNotes: [], own: [kim], allClients: all });
check("이 대상자의 이전 기록이 있으면 그것을 예시로(이름 제거)", s.length === 2 && s.every((t) => !t.includes("김가나")), JSON.stringify(s.map((t) => t.slice(0, 25))));

const others = [
  { client_id: "3", created_at: "2026-10-04T00:00:00Z", note: "■ 2026년 박다라 당사자의 욕구 : 반찬\n· 방문 상담 진행" },
  { client_id: "3", created_at: "2026-10-03T00:00:00Z", note: "■ 2026년 박다라 당사자의 욕구 : 건강\n· 최마바 어르신과 함께 방문" }, // 본문에 다른 등록 이름
  { client_id: "4", created_at: "2026-10-02T00:00:00Z", note: "■ 2026년 최마바 당사자의 욕구 : 주거\n· 주거 환경 점검" },
  { client_id: "4", created_at: "2026-10-01T00:00:00Z", note: "  " },
];
s = selectSamples({ ownNotes: [], otherNotes: others, own: [kim], allClients: all });
check("다른 대상자 기록은 첫 줄 이름을 지우고, 본문에 등록된 이름이 있는 기록은 뺀다", s.length === 2 && s.every((t) => !/박다라|최마바/.test(t)), JSON.stringify(s.map((t) => t.slice(0, 25))));
check("빈 기록은 쓰지 않는다", s.every((t) => t.trim().length > 0));
s = selectSamples({ ownNotes: [], otherNotes: [others[1]], own: [kim], allClients: all });
check("이름 없는 기록이 하나도 없으면 예시 없이", s.length === 0);
s = selectSamples({ ownNotes: [{ created_at: "2026-10-01T00:00:00Z", note: "■ 2026년 김가나 당사자의 욕구\n· 박다라 어르신과 통화" }], otherNotes: [others[0]], own: [kim], allClients: all });
check("이 대상자 기록 본문에 다른 등록 이름이 있으면 그 기록은 예시에서 빼고 다른 대상자 기록으로 대체", s.length === 1 && !/박다라|김가나/.test(s[0]), JSON.stringify(s));
// 이 대상자 기록이 있는데 전부 제외된 경우는 prepareAiContext 가 다른 대상자 기록을 따로 조회하도록 빈 배열이 돌아온다(위와 같은 입력으로 확인)
check("최대 3건", selectSamples({ ownNotes: [], otherNotes: Array.from({ length: 8 }, (_, i) => ({ client_id: "9", created_at: "2026-10-01T00:00:00Z", note: `■ 2026년 홍 당사자의 욕구 ${i}\n· 안내 ${i}` })), own: [kim], allClients: all }).length === 3);

// ── 오늘은 그만 보기 ─────────────────────────────────────────
const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const t0 = new Date("2026-10-22T05:00:00Z"); // 한국시간 10/22 14:00
check("처음에는 안내한다", !isAiNoticeHiddenToday(store, "u1", t0));
hideAiNoticeToday(store, "u1", t0);
check("같은 날 늦은 시각(한국시간 23:59)까지 숨긴다", isAiNoticeHiddenToday(store, "u1", new Date("2026-10-22T14:59:00Z")));
check("한국시간 자정이 지나면 다시 안내한다", !isAiNoticeHiddenToday(store, "u1", new Date("2026-10-22T15:00:00Z")));
check("다른 사용자는 따로 안내한다", !isAiNoticeHiddenToday(store, "u2", t0));
check("저장소가 없으면 매번 안내한다", !isAiNoticeHiddenToday(null, "u1", t0));
check("저장소가 오류를 내도 안내한다", !isAiNoticeHiddenToday({ getItem: () => { throw new Error("x"); }, setItem: () => {} }, "u1", t0));
check("todayKst: UTC 15시 이후는 다음 날", todayKst(new Date("2026-10-22T15:30:00Z")) === "2026-10-23");

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
