/**
 * 프롬프트(kanban body) 구조화 파서 — 날것 텍스트를 섹션/목록/체크리스트 블록으로.
 *
 * body 형식이 제각각(일부 `## 헤딩`+`- 불릿`, 일부 산문, 번호목록·콜론 소제목 섞임)이라
 * 마크다운-lite 로 ★가능한 만큼 구조화하고 나머지는 문단으로 둔다(가짜 구조 X).
 */
export type PromptBlock =
  | { type: 'heading'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'checklist'; items: { text: string; checked: boolean }[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'para'; text: string };

const RE_HEADING = /^#{1,4}\s+(.+?)\s*$/;
const RE_COLON_HEAD = /^([가-힣A-Za-z][가-힣A-Za-z0-9 /·]{1,18}):\s*$/; // "원칙:" "검증 체크리스트:" 같은 한 줄 소제목
const RE_CHECK = /^[-*•]\s+\[([ xX])\]\s+(.+?)\s*$/;
const RE_BULLET = /^[-*•]\s+(.+?)\s*$/;
const RE_NUM = /^(?:\d+[.)]|\(\d+\))\s+(.+?)\s*$/;

export function parsePrompt(body: string): PromptBlock[] {
  const lines = (body || '').replace(/\r/g, '').split('\n');
  const blocks: PromptBlock[] = [];
  let bullets: string[] = [];
  let checks: { text: string; checked: boolean }[] = [];
  let nums: string[] = [];
  let para: string[] = [];

  const flush = () => {
    if (bullets.length) { blocks.push({ type: 'bullets', items: bullets }); bullets = []; }
    if (checks.length) { blocks.push({ type: 'checklist', items: checks }); checks = []; }
    if (nums.length) { blocks.push({ type: 'numbered', items: nums }); nums = []; }
    if (para.length) { blocks.push({ type: 'para', text: para.join(' ').trim() }); para = []; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) { flush(); continue; }

    let m: RegExpMatchArray | null;
    if ((m = line.match(RE_HEADING))) { flush(); blocks.push({ type: 'heading', text: m[1] }); continue; }
    if ((m = line.match(RE_COLON_HEAD))) { flush(); blocks.push({ type: 'heading', text: m[1] }); continue; }
    if ((m = t.match(RE_CHECK))) { if (bullets.length || nums.length || para.length) flush(); checks.push({ text: m[2], checked: m[1].toLowerCase() === 'x' }); continue; }
    if ((m = t.match(RE_BULLET))) { if (checks.length || nums.length || para.length) flush(); bullets.push(m[1]); continue; }
    if ((m = t.match(RE_NUM))) { if (checks.length || bullets.length || para.length) flush(); nums.push(m[1]); continue; }
    para.push(t);
  }
  flush();
  return blocks;
}

/** 카드 요약 한 줄 — 첫 문단의 첫 1~2문장(의미 단위). 너무 길면 단어 경계서 자름. */
export function promptSummary(body: string): string {
  let raw = '';
  for (const b of parsePrompt(body)) {
    if (b.type === 'para') { raw = b.text; break; }
    if (b.type === 'bullets' && b.items[0]) { raw = b.items[0]; break; }
    if (b.type === 'numbered' && b.items[0]) { raw = b.items[0]; break; }
  }
  if (!raw) return '';
  // 앞쪽 마크다운/번호 기호 제거.
  raw = raw.replace(/^[#>\-*•\d.()\s]+/, '').trim();
  if (raw.length <= 160) return raw;
  // 첫 문장(마침표/。) 우선 — 의미 살려 끊기.
  const sent = raw.match(/^.*?[.。](\s|$)/);
  if (sent && sent[0].trim().length >= 30) return sent[0].trim();
  // 아니면 단어 경계서 ~150자.
  return raw.slice(0, 150).replace(/\s+\S*$/, '') + '…';
}

/** 카드에 보일 섹션 칩 — 헤딩 텍스트들(최대 n개). */
export function promptSections(body: string, max = 5): string[] {
  return parsePrompt(body).filter((b): b is { type: 'heading'; text: string } => b.type === 'heading').map((b) => b.text).slice(0, max);
}
