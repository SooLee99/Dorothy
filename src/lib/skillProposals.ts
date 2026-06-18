/**
 * Phase 6-AU — 스킬 자기개선 제안 (B: 저위험 자동 + 고위험 승인).
 *
 * 순수 로직만(파일 IO 없음): 위험도 분류 / 경로 안전성 / 칸반 신호→제안 생성.
 *
 * 안전 모델:
 *  - 모든 쓰기는 ~/.claude/skills/ 하위로만 허용(에이전트 정의·triplan git 레포 미접촉).
 *  - LOW(저위험): 기존 스킬의 references/learned/ 에 "새 .md" 추가(덮어쓰기·삭제 없음) → 자동 적용 가능.
 *  - HIGH(고위험): SKILL.md/frontmatter/agents 수정, 삭제, 보안 관련, 새 스킬 생성 → 승인 필요.
 */

export type ProposalType = 'reference-note' | 'new-skill' | 'edit-skill' | 'edit-agent' | 'delete';
export type RiskLevel = 'low' | 'high';
export type ProposalStatus = 'pending' | 'auto-applied' | 'approved' | 'rejected' | 'failed';

export interface SkillProposal {
  id: string;
  type: ProposalType;
  riskLevel: RiskLevel;
  /** ~/.claude/skills 기준 상대 경로 (예: harness/references/learned/foo.md) */
  relTarget: string;
  title: string;
  rationale: string;
  /** reference-note / new-skill 의 파일 내용(고위험 edit 은 제안만, 자동 미적용) */
  content?: string;
  source: string;
  status: ProposalStatus;
  createdAt: string;
  appliedAt?: string;
  note?: string;
}

const SECURITY_RE = /auth|secret|token|password|bearer|private[_-]?key|access[_-]?token|client[_-]?secret|보안|권한|취약/i;

/** ~/.claude/skills 기준 상대경로가 안전한 LOW 대상인지(기존 스킬의 references/learned 신규 .md) */
export function isLowRiskTarget(relTarget: string): boolean {
  if (!relTarget || relTarget.includes('..') || relTarget.startsWith('/')) return false;
  // <skill>/references/learned/<name>.md  형태만 LOW (파일명은 한글 허용)
  return /^[a-z0-9-]+\/references\/learned\/[a-z0-9가-힣-]+\.md$/i.test(relTarget);
}

/** 경로가 skills 루트를 벗어나거나 위험 위치(SKILL.md, agents, 삭제)면 true */
export function isHighRiskTarget(relTarget: string): boolean {
  if (!relTarget || relTarget.includes('..') || relTarget.startsWith('/')) return true;
  if (/(^|\/)SKILL\.md$/i.test(relTarget)) return true;
  if (/(^|\/)agents\//i.test(relTarget)) return true;
  return false;
}

export function classifyRisk(p: Pick<SkillProposal, 'type' | 'relTarget' | 'title' | 'content'>): RiskLevel {
  if (SECURITY_RE.test(p.title) || (p.content && SECURITY_RE.test(p.content))) return 'high';
  if (p.type === 'reference-note' && isLowRiskTarget(p.relTarget) && !isHighRiskTarget(p.relTarget)) return 'low';
  return 'high';
}

export function slugify(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9가-힣-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'note';
}

/** 칸반 [스킬후보] 작업 → LOW 위험 reference-note 제안(중복 slug 제거). */
export function proposalsFromKanban(
  tasks: { title?: string; description?: string; column?: string; status?: string }[],
  now: string,
): SkillProposal[] {
  const out: SkillProposal[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    const title = t.title || '';
    if (!/\[스킬후보\]|스킬후보|skill[- ]?candidate/i.test(title)) continue;
    if ((t.column || t.status) === 'done') continue;
    const slug = slugify(title);
    if (seen.has(slug)) continue;
    seen.add(slug);
    const relTarget = `harness/references/learned/${slug}.md`;
    const proposal: SkillProposal = {
      id: `sp-${slug}`,
      type: 'reference-note',
      riskLevel: 'low',
      relTarget,
      title: title.replace(/\s+/g, ' ').trim(),
      rationale: '칸반에서 반복 감지된 스킬 후보 — harness 학습 참조로 축적',
      content: `# ${title.trim()}\n\n> 자동 수집된 스킬 후보 메모 (Phase 6-AU 자기개선)\n\n${(t.description || '').trim() || '(설명 없음)'}\n\n---\n출처: kanban skill-candidate\n수집: ${now}\n`,
      source: 'kanban:skill-candidate',
      status: 'pending',
      createdAt: now,
    };
    proposal.riskLevel = classifyRisk(proposal);
    out.push(proposal);
  }
  return out;
}
