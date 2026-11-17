/**
 * AI에 보내는 대상자 지칭을 이름 대신 대상자 번호(JN0018)로 바꾸고, 돌려받은 글에서는 다시 이름으로 되돌린다.
 *
 * - 이름 칸(구조화된 항목)만 번호로 바꾼다. 상담 내용 같은 글 속의 이름은 그대로 전달된다(부분 효과).
 * - 되돌릴 때 조사가 어색해지지 않도록 AI에게 '번호 님' 형태로 쓰게 하고, 번호 바로 뒤의 조사는 '님'에 맞게 고친다.
 * - 번호가 없는 대상자는 이름을 그대로 쓴다.
 * - 문제가 생기면 AI_USE_CLIENT_CODE 를 false 로 바꾸면 예전처럼 이름을 보낸다.
 */
export const AI_USE_CLIENT_CODE = true;

export type NameRef = { id?: string; name: string; client_code?: string | null };

/** AI에 보낼 지칭: 번호가 있으면 번호, 없으면 이름 */
export function aiLabel(c: NameRef): string {
  return AI_USE_CLIENT_CODE && c.client_code ? c.client_code : c.name;
}

/** AI 프롬프트에 붙이는 호칭 규칙 */
export const AI_CODE_RULE =
  "대상자는 데이터에 적힌 name(또는 [ ] 안의) 값 그대로 지칭하세요. 번호(예: JN0018)로 적혀 있으면 번호를 바꾸거나 이름을 추측하지 말고, 'JN0018 님은', 'JN0018 님께'처럼 번호 뒤에 '님'을 붙여 쓰세요. 상담 기록 안에 이름이 적혀 있더라도 대상자는 번호로만 지칭하고, 괄호 등으로 번호와 이름을 함께 적지 마세요.";

const PARTICLE_AFTER_NIM: Record<string, string> = {
  은: "은", 는: "은", 이: "이", 가: "이", 을: "을", 를: "을", 과: "과", 와: "과",
  으로: "으로", 로: "으로", 이라: "이라", 라: "이라",
};

const CODE_RE =
  /(?<![A-Za-z0-9])([A-Z]{2,4}\d{4,})(?![A-Za-z0-9])(?:\s*(?=어르신|님|대상자|당사자|씨)|(으로|이라|은|는|이|가|을|를|과|와|로|라)(?![가-힣]))?/g;

/** 글 속의 대상자 번호를 이름으로 되돌린다. 모르는 번호는 그대로 둔다. */
export function restoreNames(text: string, clients: NameRef[]): string {
  if (!text) return text;
  const byCode = new Map<string, string>();
  for (const c of clients) if (c.client_code) byCode.set(c.client_code, c.name);
  if (byCode.size === 0) return text;
  const used = new Set<string>();
  let out = text.replace(CODE_RE, (m: string, code: string, particle: string | undefined) => {
    const name = byCode.get(code);
    if (!name) return m;
    used.add(name);
    if (particle) return `${name} 님${PARTICLE_AFTER_NIM[particle] ?? particle}`; // 번호 + 조사 → 이름 님 + 알맞은 조사
    return name + m.slice(code.length); // 호칭이 이미 붙었으면 공백까지 그대로 유지
  });
  // AI가 상담 기록에서 본 이름과 번호를 함께 적은 경우("강나다 님(JN0018 님)")가 되돌린 뒤 "강나다 님(강나다 님)"이 되므로 하나로 합친다
  for (const name of used) {
    const n = esc(name);
    out = out.replace(
      new RegExp(`${n}(\\s?님)?\\s*[(（]\\s*${n}(?:\\s?님)?\\s*[)）]`, "g"),
      (_m: string, title: string | undefined) => `${name}${title ?? ""}`,
    );
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SPACE_RE = new RegExp("[" + String.fromCharCode(92) + "s" + String.fromCharCode(0xa0, 0x200b, 0x3000) + "]+", "g"); // 일반 공백·줄바꿈·NBSP·제로폭 공백·전각 공백
const squash = (s: string) => s.replace(SPACE_RE, "");
/** 이름 끝에 동명이인 구분용으로 붙인 숫자를 뗀 이름 (김가나6 → 김가나) */
const baseOf = (s: string) => squash(s).replace(/[0-9]+$/, "");

export type NameHit = { from: string; clients: NameRef[] };

// 이름 바로 뒤에 올 수 있는 것: (호칭) + (조사 0~2개) 다음에 한글이 더 이어지지 않는 경우.
// "박다라씨는", "김가나님이", "박다라에게도", "김가나입니다"처럼 호칭+조사, 조사가 겹친 형태도 이름으로 인식한다.
// 한글이 더 이어지면(다른 이름의 일부 등) 인식하지 않는다.
const FULL_TAIL =
  "(?=(?:어르신|님|씨)?(?:에게서|에게|에서|께서|한테|이랑|으로|이라는|이라|이란|이에요|입니다|이나|은|는|이|가|을|를|과|와|도|만|의|에|께|로|랑|나){0,2}(?![가-힣]))";
const TITLE_AHEAD = "(?=\\s*(?:어르신|님|씨|할머니|할아버지))";

/**
 * 담당자가 입력한 질문 속 대상자 이름을 번호로 바꾼다(AI가 번호로 된 자료와 이름을 연결할 수 있게).
 * - 이름 앞뒤·사이의 공백은 무시하고 맞춘다. 긴 이름부터 맞춘다.
 * - 같은 이름이 둘 이상이면 후보 번호를 모두 '/'로 이어서 보낸다(AI가 각각 구분해 답한다).
 * - 성을 빼고 이름만 부르는 경우("나다 어르신")는 '수정', '지원' 같은 일반 단어와 겹칠 수 있어, 바로 뒤에 호칭이 붙었을 때만 바꾼다.
 * 어떤 이름을 어느 대상자로 인식했는지(hits)도 돌려줘서 화면에 보여 줄 수 있다.
 */
export function codifyNamesDetailed(text: string, clients: NameRef[]): { text: string; hits: NameHit[] } {
  const hits: NameHit[] = [];
  if (!AI_USE_CLIENT_CODE || !text) return { text, hits };
  const coded = clients.filter((c) => c.client_code);
  if (coded.length === 0) return { text, hits };

  // 1) 전체 이름
  const byFull = new Map<string, NameRef[]>();
  for (const c of coded) {
    const n = squash(c.name);
    if (n.length >= 2) byFull.set(n, [...(byFull.get(n) ?? []), c]);
  }
  let out = text;
  if (byFull.size > 0) {
    const names = [...byFull.keys()].sort((a, b) => b.length - a.length);
    const re = new RegExp(`(?<![가-힣A-Za-z0-9])(${names.map(esc).join("|")})${FULL_TAIL}`, "g");
    out = out.replace(re, (m: string) => {
      const cs = byFull.get(m);
      if (!cs) return m;
      hits.push({ from: m, clients: cs });
      return cs.map((c) => c.client_code).join("/");
    });
  }

  // 2) 성을 뺀 이름 + 호칭
  const byGiven = new Map<string, NameRef[]>();
  for (const c of coded) {
    const b = baseOf(c.name);
    if (/^[가-힣]{3}$/.test(b)) byGiven.set(b.slice(1), [...(byGiven.get(b.slice(1)) ?? []), c]);
  }
  const allFull = new Set(clients.map((c) => squash(c.name)));
  const givens = [...byGiven.keys()].filter((g) => !allFull.has(g)); // 다른 대상자의 전체 이름과 같으면 제외
  if (givens.length > 0) {
    const re2 = new RegExp(`(?<![가-힣A-Za-z0-9])(${givens.map(esc).join("|")})${TITLE_AHEAD}`, "g");
    out = out.replace(re2, (m: string) => {
      const cs = byGiven.get(m);
      if (!cs) return m;
      hits.push({ from: m, clients: cs });
      return cs.map((c) => c.client_code).join("/");
    });
  }
  return { text: out, hits };
}

export function codifyNames(text: string, clients: NameRef[]): string {
  return codifyNamesDetailed(text, clients).text;
}

/**
 * 상담 다듬기 결과의 첫 줄('■ 2026년 ○○ 당사자의 …')에 대상자 이름이 들어가게 보장한다.
 * AI가 번호를 '대상자' 같은 말로 바꿔 버린 경우에만 이름을 채우고, 그 외에는 건드리지 않는다.
 */
export function ensureHeaderName(text: string, c: NameRef): string {
  return text.replace(/(■\s*\d{4}년\s+)([^\n]*?)(\s*당사자의)/, (m: string, pre: string, mid: string, post: string) => {
    const t = mid.trim();
    if (t === c.name) return m;
    if (t === "" || /^(해당\s*)?(대상자|어르신|당사자|OOO|○○○|XXX)$/.test(t)) return `${pre}${c.name} ${post.trim()}`;
    return m;
  });
}

/**
 * 저장된 상담기록 첫 줄('■ 2026년 홍길동 당사자의 …')의 이름 자리를 '대상자'로 바꾼다.
 * 이전 기록을 AI 에 참고 자료로 보낼 때 쓴다. 이름이 번호든 이름이든 같은 모양으로 맞추고, 되돌릴 필요는 없다
 * (AI 가 '대상자'라고 적어 돌려주면 ensureHeaderName 이 이름을 채운다).
 */
export function neutralizeHeaderName(text: string): string {
  return text.replace(/(■\s*\d{4}년\s+)([^\n]*?)(\s*당사자의)/, (_m: string, pre: string, _mid: string, post: string) => `${pre}대상자 ${post.trim()}`);
}

/**
 * 글 속에서 주어진 대상자들의 이름을 찾아 replacement('대상자')로 바꾼다. 바꾼 횟수(count)도 돌려줘서
 * "등록된 이름이 들어 있는 글인지" 판별하는 데도 쓴다.
 * - 이름 뒤의 호칭·조사는 그대로 둔다(codifyNames 와 같은 규칙: 한글이 더 이어지면 다른 낱말로 보고 건드리지 않는다).
 * - 동명이인 구분용 숫자를 뗀 이름(김가나6 → 김가나)도 함께 찾는다.
 * - 성을 뺀 이름은 바로 뒤에 호칭이 붙었을 때만 찾는다('수정', '지원' 같은 일반 단어와 겹치지 않게).
 * 번호(client_code)가 없는 대상자도 포함한다.
 */
export function maskNamesInText(text: string, clients: NameRef[], replacement = "대상자"): { text: string; count: number } {
  if (!text || clients.length === 0) return { text, count: 0 };
  let count = 0;
  const fullNames = new Set<string>();
  for (const c of clients) {
    for (const n of [squash(c.name), baseOf(c.name)]) if (n.length >= 2) fullNames.add(n);
  }
  let out = text;
  if (fullNames.size > 0) {
    const names = [...fullNames].sort((a, b) => b.length - a.length);
    const re = new RegExp(`(?<![가-힣A-Za-z0-9])(${names.map(esc).join("|")})${FULL_TAIL}`, "g");
    out = out.replace(re, () => {
      count++;
      return replacement;
    });
  }
  const givens = new Set<string>();
  for (const c of clients) {
    const b = baseOf(c.name);
    if (/^[가-힣]{3}$/.test(b)) givens.add(b.slice(1));
  }
  const given = [...givens].filter((g) => !fullNames.has(g));
  if (given.length > 0) {
    const re2 = new RegExp(`(?<![가-힣A-Za-z0-9])(${given.map(esc).join("|")})${TITLE_AHEAD}`, "g");
    out = out.replace(re2, () => {
      count++;
      return replacement;
    });
  }
  return { text: out, count };
}
