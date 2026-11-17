/**
 * 상담기록·제공이력에서 "이미 제공한 물품"을 찾아낸다(자원 배분 도우미용).
 * - AI가 "이불 필요"라는 옛 기록만 보고 이미 지급한 대상자를 다시 추천하는 일을 막기 위해,
 *   코드가 먼저 "이미 제공" 후보를 뽑아 AI에 힌트로 주고, 추천 뒤에도 같은 물품의 제공 기록이 있으면 경고한다.
 * - 정확한 판정이 아니라 단서이므로 문장(근거)을 같이 남겨 사람이 확인할 수 있게 한다.
 */

import { toKstDate } from "./log-time";

export type ProvidedHit = {
  /** 물품 대표어(예: 이불) */
  item: string;
  /** 질문에 이 말이 들어 있으면 같은 물품으로 본다 */
  keys: string[];
  /** 제공한 날짜(YYYY-MM-DD) */
  date: string;
  source: "상담기록" | "제공이력";
  /** 상담기록에서 찾았다면 그 기록 id(근거 보기용) */
  logId?: string;
  /** 근거 문장(최대 60자) */
  snippet: string;
  /** 제공 이후에 같은 물품이 다시 필요하다고 적힌 가장 최근 날짜 */
  laterNeedDate?: string | null;
};

type LogLike = { id: string; client_id: string; note: string | null; created_at: string };
type ProvisionLike = { client_id: string; category: string | null; title: string | null; note?: string | null; provided_at: string };

// 물품 대표어 → 같은 뜻의 표현들. 자주 쓰는 것부터 두고 필요하면 늘린다.
export const ITEM_SYNONYMS: Record<string, string[]> = {
  이불: ["이불", "침구", "이부자리", "솜이불"],
  담요: ["담요"],
  전기장판: ["전기장판", "전기요", "온열매트"],
  쌀: ["쌀", "백미"],
  반찬: ["반찬", "밑반찬"],
  도시락: ["도시락"],
  삼계탕: ["삼계탕"],
  선풍기: ["선풍기"],
  연탄: ["연탄"],
  난방유: ["난방유", "등유"],
  김치: ["김치"],
  라면: ["라면"],
  생필품: ["생필품", "생활용품", "생활필수품"],
  마스크: ["마스크"],
  의류: ["의류", "겨울옷", "패딩", "외투"],
  신발: ["신발", "운동화"],
  기저귀: ["기저귀"],
  영양제: ["영양제", "영양식", "건강식품"],
};

const DONE_RE =
  /(지급|배분|전달|제공|지원|배달|교체|설치|후원|기부)\s*(?:을\s*|를\s*)?(완료|함|했|하였|하셨|됨|되었|받|해\s*드|해드)|드림|드렸|드리었|수령|받았|받음|받으셨|전해\s*드|가져다\s*드/;
// "이불 지급"처럼 문장이 물품+동작명사로 끝나는 개조식 기록
const DONE_TAIL_RE = /(지급|배분|전달|제공|배달)\s*$/;
// 아직 하지 않았거나 하지 못한 표현: 이 표현이 있으면 완료로 보지 않는다
// - "미제공·미지급…"은 이 앱이 "미제공(수령 거부·부재 등)" 기록으로 직접 남기는 문구라 반드시 걸러야 한다
// - "받고 싶어하심·받기 원함", "못 받음", "신청해 드림", "…여부 확인 필요"는 아직 제공된 것이 아니다
const NOT_DONE_RE =
  /예정|하기로|할\s*계획|하려|하고자|검토|확인\s*후|안\s*함|하지\s*(않|못)|못\s*함|불가|거부|거절|보류|취소|미\s*(제공|지급|전달|배분|배달|수령|지원)|받고\s*싶|받기\s*(를\s*)?(원|희망)|받길|받았으면|받고자|못\s*(받|드|주|전)|신청\s*(해|하여|해서)?\s*드|신청\s*(방법|안내|절차)|여부|확인\s*필요/;
// "드림·드렸"은 안내·연락에도 쓰인다("이불 지원 안내드림"). 안내·전화 같은 말이 있고 실제 제공 동작어가 없으면 완료로 보지 않는다.
const CONTACT_ONLY_RE = /안내|전화|연락|문의|설명|상담/;
const GIVE_ACTION_RE = /지급|배분|전달|제공|배달|가져다|전해|갖다|드렸다|설치/;
const NEED_RE = /필요|요청|신청|희망|원함|원하|부족|없어|없음|낡|오래되|얇|문의|교체\s*필요/;

const GENERIC_STOP = new Set(["서비스", "물품", "자원", "후원", "지원", "관련", "추가", "정보", "안내", "내용", "연계", "상담", "방문"]);
const GENERIC_RE = /([가-힣]{2,6})\s*(?:을|를)?\s*(?:\d+\s*[가-힣]{0,2}\s*)?(?:지급|배분|전달|제공|배달|설치)\s*(?:완료|함|했|하였|됨|되었)/g;

function canonicalOf(word: string): { item: string; keys: string[] } | null {
  for (const [item, syn] of Object.entries(ITEM_SYNONYMS)) {
    if (syn.some((s) => word.includes(s))) return { item, keys: syn };
  }
  return null;
}

function clausesOf(text: string): string[] {
  return text
    .split(/[\n\r,，;·•▪■▶○●※]|\.\s|\.$|[()]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

type Found = { item: string; keys: string[]; snippet: string };

/** 한 문서(상담기록 한 건)에서 제공 완료 / 필요 표현을 찾는다 */
export function scanNote(note: string): { done: Found[]; need: Found[] } {
  const done: Found[] = [];
  const need: Found[] = [];
  for (const clause of clausesOf(note)) {
    const snippet = clause.slice(0, 60);
    const contactOnly = CONTACT_ONLY_RE.test(clause) && !GIVE_ACTION_RE.test(clause);
    const isDone = !NOT_DONE_RE.test(clause) && !contactOnly && (DONE_RE.test(clause) || DONE_TAIL_RE.test(clause));
    const isNeed = !isDone && NEED_RE.test(clause);
    if (!isDone && !isNeed) continue;
    const target = isDone ? done : need;

    const seen = new Set<string>();
    for (const [item, syn] of Object.entries(ITEM_SYNONYMS)) {
      if (syn.some((s) => clause.includes(s)) && !seen.has(item)) {
        seen.add(item);
        target.push({ item, keys: syn, snippet });
      }
    }
    if (isDone) {
      // 목록에 없는 물품도 "○○ 지급함" 꼴이면 잡는다
      for (const m of clause.matchAll(GENERIC_RE)) {
        const word = m[1];
        if (GENERIC_STOP.has(word)) continue;
        const c = canonicalOf(word);
        const item = c?.item ?? word;
        if (seen.has(item)) continue;
        seen.add(item);
        target.push({ item, keys: c?.keys ?? [word], snippet });
      }
    }
  }
  return { done, need };
}

/**
 * 대상자별 "이미 제공한 물품" 목록. cutoffDate(YYYY-MM-DD) 이전 기록은 보지 않는다.
 * 같은 물품은 가장 최근 제공 건만 남기고, 그 뒤에 다시 필요하다는 기록이 있으면 laterNeedDate 를 붙인다.
 */
export function buildProvidedMap(args: {
  logs: LogLike[];
  provisions: ProvisionLike[];
  cutoffDate: string;
}): Map<string, ProvidedHit[]> {
  const doneBy = new Map<string, Map<string, ProvidedHit>>(); // client → item → 최근 제공
  const needBy = new Map<string, Map<string, string>>(); // client → item → 가장 최근 필요 언급 날짜

  const putDone = (clientId: string, hit: ProvidedHit) => {
    let m = doneBy.get(clientId);
    if (!m) doneBy.set(clientId, (m = new Map()));
    const prev = m.get(hit.item);
    if (!prev || hit.date > prev.date) m.set(hit.item, hit);
  };

  for (const l of args.logs) {
    const date = toKstDate(l.created_at);
    if (date < args.cutoffDate || !l.note) continue;
    const { done, need } = scanNote(l.note);
    for (const d of done) putDone(l.client_id, { item: d.item, keys: d.keys, date, source: "상담기록", logId: l.id, snippet: d.snippet });
    for (const n of need) {
      let m = needBy.get(l.client_id);
      if (!m) needBy.set(l.client_id, (m = new Map()));
      const prev = m.get(n.item);
      if (!prev || date > prev) m.set(n.item, date);
    }
  }

  for (const p of args.provisions) {
    const date = p.provided_at.slice(0, 10);
    if (date < args.cutoffDate) continue;
    // 제목·메모에서 먼저 찾는다(분류는 "생필품"처럼 넓은 말이라, 제목에서 못 찾았을 때만 쓴다)
    const found = new Set<string>();
    for (const text of [`${p.title ?? ""} ${p.note ?? ""}`, p.category ?? ""]) {
      if (found.size > 0) break;
      for (const [item, syn] of Object.entries(ITEM_SYNONYMS)) {
        if (syn.some((s) => text.includes(s))) {
          found.add(item);
          putDone(p.client_id, { item, keys: syn, date, source: "제공이력", snippet: `${p.title ?? p.category ?? ""}`.slice(0, 60) });
        }
      }
    }
    // 목록에 없는 물품: 제목 자체를 물품으로 본다(질문에 제목의 낱말이 들어 있으면 같은 물품)
    const title = (p.title ?? "").trim();
    if (found.size === 0 && title) {
      const tokens = title.split(/\s+/).filter((t) => t.length >= 2 && !GENERIC_STOP.has(t));
      if (tokens.length) putDone(p.client_id, { item: title.slice(0, 12), keys: tokens, date, source: "제공이력", snippet: title.slice(0, 60) });
    }
  }

  const out = new Map<string, ProvidedHit[]>();
  for (const [clientId, items] of doneBy) {
    const list = [...items.values()].map((h) => {
      const needDate = needBy.get(clientId)?.get(h.item);
      return needDate && needDate > h.date ? { ...h, laterNeedDate: needDate } : h;
    });
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    out.set(clientId, list.slice(0, 12));
  }
  return out;
}

/** AI에 줄 한 줄 힌트. 예: 이미제공:이불(2026-09-15),쌀(2026-10-01→2026-10-20재필요언급) */
export function formatProvidedForContext(hits: ProvidedHit[] | undefined, max = 6): string {
  if (!hits?.length) return "";
  return (
    " 이미제공:" +
    hits
      .slice(0, max)
      .map((h) => `${h.item}(${h.date}${h.laterNeedDate ? `→${h.laterNeedDate}재필요언급` : ""})`)
      .join(",")
  );
}

/** 질문에 나온 물품과 같은 "이미 제공" 기록만 골라 경고 목록을 만든다 */
export function matchWarnings(hits: ProvidedHit[] | undefined, question: string): ProvidedHit[] {
  if (!hits?.length) return [];
  return hits.filter((h) => h.keys.some((k) => k && question.includes(k)));
}
