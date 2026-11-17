/**
 * 매뉴얼·참고자료에서 질문과 관련된 부분을 찾는 도구.
 * - 자료가 작으면 ManualTab 이 검색 없이 전부 AI 에 넘기고, 자료가 클 때만 rankChunks 로 관련 부분만 고른다.
 * - 조사("초기상담은")·의문 표현("어떻게 하나요")에 휘둘리지 않도록 두 글자 조각(bigram) 일치로 점수를 매기고,
 *   자료에 드문 조각일수록 가중치를 준다(IDF). 같은 뜻의 다른 말(상담↔면접 등)은 작은 동의어 묶음으로 보완한다.
 */

export type SearchChunk = { page: number; text: string };

// 질문에 자주 붙는 말: 검색 점수에서 뺀다
const STOPWORDS = [
  "어떻게", "하나요", "인가요", "무엇", "알려줘", "알려주세요", "알려", "해주세요", "있나요", "되나요", "하는", "한다",
  "해요", "대해", "관련", "방법", "내용", "주세요", "찾아줘", "다시", "뭔가요", "언제", "어디",
];

// 사회복지 현장에서 같은 뜻으로 섞어 쓰는 말. 질문에 한쪽이 있으면 나머지도 검색어에 더한다.
const SYNONYMS: string[][] = [
  ["초기상담", "초기면접", "접수면접", "인테이크"],
  ["상담", "면접"],
  ["종결", "종료"],
  ["재사정", "재평가"],
  ["사정", "평가"],
  ["욕구", "필요"],
  ["위기", "긴급"],
];

const norm = (s: string) => s.replace(/[^가-힣A-Za-z0-9]/g, "").toLowerCase();

function grams(s: string): string[] {
  const t = norm(s);
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** 질문과 관련 있어 보이는 순으로 최대 n 개를 돌려준다. 일치하는 곳이 없으면 앞에서부터 n 개. */
export function rankChunks<T extends SearchChunk>(chunks: T[], question: string, n: number): T[] {
  if (chunks.length === 0) return [];
  const qNorm = norm(question);
  let q = question;
  for (const group of SYNONYMS) {
    if (group.some((w) => qNorm.includes(norm(w)))) q += " " + group.join(" ");
  }
  for (const w of STOPWORDS) q = q.split(w).join(" ");
  const qGrams = [...new Set(grams(q))];
  if (qGrams.length === 0) return chunks.slice(0, n);

  const gramSets = chunks.map((c) => new Set(grams(c.text)));
  const df = new Map<string, number>();
  for (const set of gramSets) for (const g of set) df.set(g, (df.get(g) ?? 0) + 1);
  const idf = (g: string) => Math.log((chunks.length + 1) / ((df.get(g) ?? 0) + 0.5));

  const scored = chunks.map((chunk, i) => {
    let score = 0;
    for (const g of qGrams) if (gramSets[i].has(g)) score += idf(g);
    return { chunk, score, i };
  });
  const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const pool = hits.length > 0 ? hits : scored;
  return pool.slice(0, n).map((x) => x.chunk);
}

/**
 * AI 답변에 적힌 "(출처명 ○페이지)" 표기를 읽어, 인용된 자료 조각을 돌려준다(최대 max 개).
 * 자료가 여러 개면 페이지 앞에 적힌 출처명(앞 6글자)으로 어느 자료인지 가린다.
 */
export function pickCitedChunks<T extends SearchChunk & { sourceTitle?: string }>(
  answer: string,
  chunks: T[],
  max = 6,
): T[] {
  const re = /((?:[0-9]{1,4}[ ]*(?:,|·|및|와|과|~|-)[ ]*)*[0-9]{1,4})[ ]*(?:페이지|쪽)/g;
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const m of answer.matchAll(re)) {
    const idx = m.index ?? 0;
    const before = norm(answer.slice(Math.max(0, idx - 80), idx));
    const pages = (m[1].match(/[0-9]{1,4}/g) ?? []).map(Number);
    for (const page of pages) {
      const cands = chunks.filter((c) => c.page === page);
      if (cands.length === 0) continue;
      let best = cands[0];
      let bestLen = -1;
      for (const c of cands) {
        const t = norm(c.sourceTitle ?? "").slice(0, 6);
        if (t.length >= 3 && before.includes(t) && t.length > bestLen) {
          best = c;
          bestLen = t.length;
        }
      }
      const key = `${(best as { sourceTitle?: string }).sourceTitle ?? ""}#${page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(best);
      if (picked.length >= max) return picked;
    }
  }
  return picked;
}
