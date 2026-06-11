import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { proposalsFromKanban, classifyRisk, isHighRiskTarget, type SkillProposal } from '@/lib/skillProposals';

export const dynamic = 'force-dynamic';

/**
 * Phase 6-AU — 스킬 자기개선 제안 store/적용 (B: 저위험 자동 + 고위험 승인).
 *
 * SAFETY:
 *  - 모든 쓰기는 SKILLS_ROOT(~/.claude/skills) 하위로만. 경로 이탈/agents/삭제 금지.
 *  - LOW(references/learned 신규 .md): 설정 ON 이면 detect 시 자동 적용, 덮어쓰기 없음.
 *  - HIGH: confirm:true 필요 + 덮어쓰기 시 백업. delete/agents 는 거부(수동).
 *  - secret 류 내용은 저장/적용 안 함.
 */

const HOME = os.homedir();
const SKILLS_ROOT = path.join(HOME, '.claude', 'skills');
const STORE = path.join(HOME, '.dorothy', 'skill-proposals.json');
const SETTINGS = path.join(HOME, '.dorothy', 'app-settings.json');
const KANBAN = path.join(HOME, '.dorothy', 'kanban-tasks.json');
const K_ENABLED = 'dorothySkillSelfImprovementEnabled';
const K_AUTO_LOW = 'dorothyAutoApplyLowRiskSkillProposals';

function readStore(): SkillProposal[] {
  try { const v = JSON.parse(fs.readFileSync(STORE, 'utf-8')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeStore(list: SkillProposal[]) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(list, null, 2));
}
function readSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf-8')); } catch { return {}; }
}
function writeSettings(s: Record<string, unknown>) { fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2)); }
function readKanban(): { title?: string; description?: string; column?: string }[] {
  try { const v = JSON.parse(fs.readFileSync(KANBAN, 'utf-8')); return Array.isArray(v) ? v : (v.tasks ?? []); } catch { return []; }
}

/** relTarget 을 SKILLS_ROOT 안의 절대경로로 안전 해석(이탈 시 null) */
function safeResolve(relTarget: string): string | null {
  if (!relTarget || relTarget.includes('..') || relTarget.startsWith('/')) return null;
  const abs = path.resolve(SKILLS_ROOT, relTarget);
  if (abs !== SKILLS_ROOT && !abs.startsWith(SKILLS_ROOT + path.sep)) return null;
  return abs;
}

/** 제안 1건 실제 적용. ok/note 반환. (안전 경계 강제) */
function applyProposal(p: SkillProposal, confirm: boolean): { ok: boolean; note: string } {
  if (p.type === 'delete') return { ok: false, note: '삭제는 자동 적용하지 않습니다(수동 처리)' };
  if (isHighRiskTarget(p.relTarget) || p.type === 'edit-agent') return { ok: false, note: 'agents/SKILL.md 등 고위험 경로는 자동 적용 불가(수동 검토)' };
  const risk = classifyRisk(p);
  if (risk === 'high' && !confirm) return { ok: false, note: '고위험 제안 — confirm:true 승인 필요' };
  if (!p.content) return { ok: false, note: '적용할 내용 없음' };

  const abs = safeResolve(p.relTarget);
  if (!abs) return { ok: false, note: 'SKILLS_ROOT 밖 경로 — 거부' };

  // <skill> 디렉터리는 이미 존재해야 함(새 스킬 루트 자동 생성 안 함; new-skill 은 confirm 필요)
  const skillName = p.relTarget.split('/')[0];
  const skillDir = path.join(SKILLS_ROOT, skillName);
  if (p.type !== 'new-skill' && !fs.existsSync(skillDir)) return { ok: false, note: `대상 스킬(${skillName}) 없음` };
  if (p.type === 'new-skill' && !confirm) return { ok: false, note: '새 스킬 생성은 confirm:true 필요' };

  const exists = fs.existsSync(abs);
  if (exists && risk === 'low') return { ok: false, note: '이미 존재 — 저위험은 덮어쓰지 않음' };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (exists) fs.copyFileSync(abs, `${abs}.bak.${Date.now()}`); // 고위험 덮어쓰기 백업
    fs.writeFileSync(abs, p.content);
    return { ok: true, note: exists ? '백업 후 갱신' : '신규 생성' };
  } catch (e) {
    return { ok: false, note: `쓰기 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function GET() {
  const s = readSettings();
  return NextResponse.json({
    proposals: readStore(),
    enabled: s[K_ENABLED] !== false,          // 기본 true
    autoApplyLowRisk: s[K_AUTO_LOW] !== false, // 기본 true (B)
    skillsRoot: SKILLS_ROOT.replace(HOME, '~'),
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action as string;
  const s = readSettings();

  if (action === 'setAuto') {
    if (typeof body.value !== 'boolean') return NextResponse.json({ ok: false, error: 'value:boolean 필요' }, { status: 400 });
    s[K_AUTO_LOW] = body.value; writeSettings(s);
    return NextResponse.json({ ok: true, autoApplyLowRisk: body.value });
  }
  if (action === 'setEnabled') {
    if (typeof body.value !== 'boolean') return NextResponse.json({ ok: false, error: 'value:boolean 필요' }, { status: 400 });
    s[K_ENABLED] = body.value; writeSettings(s);
    return NextResponse.json({ ok: true, enabled: body.value });
  }

  if (action === 'detect') {
    if (s[K_ENABLED] === false) return NextResponse.json({ ok: false, error: '자기개선 비활성화됨' }, { status: 409 });
    const now = new Date().toISOString();
    const store = readStore();
    const known = new Set(store.map(p => p.id));
    const fresh = proposalsFromKanban(readKanban(), now).filter(p => !known.has(p.id));
    const autoLow = s[K_AUTO_LOW] !== false;
    let autoApplied = 0;
    for (const p of fresh) {
      // 이미 파일이 있으면 적용완료로 표시(중복 방지)
      const abs = safeResolve(p.relTarget);
      if (abs && fs.existsSync(abs)) { p.status = 'auto-applied'; p.appliedAt = now; p.note = '이미 존재'; store.push(p); continue; }
      if (p.riskLevel === 'low' && autoLow) {
        const r = applyProposal(p, false);
        p.status = r.ok ? 'auto-applied' : 'pending';
        if (r.ok) { p.appliedAt = now; autoApplied++; }
        p.note = r.note;
      }
      store.push(p);
    }
    writeStore(store);
    return NextResponse.json({ ok: true, detected: fresh.length, autoApplied, pending: store.filter(p => p.status === 'pending').length, proposals: store });
  }

  if (action === 'apply') {
    const id = body.id as string;
    const confirm = body.confirm === true;
    const store = readStore();
    const p = store.find(x => x.id === id);
    if (!p) return NextResponse.json({ ok: false, error: '제안 없음' }, { status: 404 });
    const r = applyProposal(p, confirm);
    p.status = r.ok ? (classifyRisk(p) === 'high' ? 'approved' : 'auto-applied') : 'failed';
    if (r.ok) p.appliedAt = new Date().toISOString();
    p.note = r.note;
    writeStore(store);
    return NextResponse.json({ ok: r.ok, note: r.note, proposals: store });
  }

  if (action === 'reject') {
    const id = body.id as string;
    const store = readStore();
    const p = store.find(x => x.id === id);
    if (!p) return NextResponse.json({ ok: false, error: '제안 없음' }, { status: 404 });
    p.status = 'rejected'; p.note = '사용자 거절';
    writeStore(store);
    return NextResponse.json({ ok: true, proposals: store });
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
