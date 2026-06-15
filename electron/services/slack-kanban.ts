// slack-kanban.ts — #-tasks 채널 칸반 명령 경로 (2-A: create 전용)
//
// 설계 의도(★30분 지연 해결):
//   기존 자유대화는 sendToSuperAgentFromSlack → writeProgrammaticInput 으로 ★바쁜 Super Agent
//   PTY stdin 에 직접 주입했고, 그 PTY 가 턴 경계에 도달할 때까지 응답이 ~30분 지연됐다.
//   이 모듈은 PTY 를 ★전혀 건드리지 않고 `claude --print` 단발 헤드리스 호출로 의도를 파싱한 뒤
//   칸반 파일에 직접 create 한다 → 바쁜 PTY 와 무관 = 지연 없음.
//
// 범위(확정): 1-B + 2-A + 3-없음.
//   - create(추가)만 지원. fix/삭제/우선순위 변경은 거부(Slack B 게이트, 추후).
//   - ★적용 전 확인(reply 기반): 오파싱 대비 사람이 "네/아니요"로 승인해야 실제 create.
//   - 빈 채널/대화 채널 생성 안 함. dispatch 코드 불변.
import { spawn } from 'child_process';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { KANBAN_FILE, DATA_DIR } from '../constants';
import { AppSettings } from '../types';
import { resolveClaudeBinaryPath } from '../core/claude-binary-resolver';

// 알려진 프로젝트 이름 → 경로 매핑(기존 kanban-tasks.json 분포 기준). 모호하면 triplan 기본.
const PROJECT_MAP: Record<string, { id: string; path: string }> = {
  triplan: { id: 'triplan', path: '/Users/soo/workspace/source-code/triplan' },
  frontend: { id: 'triplan-frontend', path: '/Users/soo/workspace/source-code/triplan/triplan-frontend' },
  'triplan-frontend': { id: 'triplan-frontend', path: '/Users/soo/workspace/source-code/triplan/triplan-frontend' },
  backend: { id: 'triplan-travel-service', path: '/Users/soo/workspace/source-code/triplan/triplan-travel-service' },
  travel: { id: 'triplan-travel-service', path: '/Users/soo/workspace/source-code/triplan/triplan-travel-service' },
  'triplan-travel-service': { id: 'triplan-travel-service', path: '/Users/soo/workspace/source-code/triplan/triplan-travel-service' },
  bueongi: { id: 'bueongi', path: '/Users/soo/workspace/source-code/apps/bueongi' },
};
const DEFAULT_PROJECT = PROJECT_MAP['triplan'];

function resolveProject(hint: string | null | undefined): { id: string; path: string } {
  if (!hint) return DEFAULT_PROJECT;
  const key = hint.toLowerCase().trim();
  if (PROJECT_MAP[key]) return PROJECT_MAP[key];
  // 부분 일치 시도(예: "프론트", "front")
  if (key.includes('front')) return PROJECT_MAP['frontend'];
  if (key.includes('back') || key.includes('travel') || key.includes('서버') || key.includes('api'))
    return PROJECT_MAP['backend'];
  if (key.includes('bueongi') || key.includes('붕어')) return PROJECT_MAP['bueongi'];
  return DEFAULT_PROJECT;
}

interface KanbanIntent {
  action: 'create' | 'other';
  title: string;
  description: string;
  project: string | null;
}

// 채널별 보류 중인 create 의도(확인 대기). 적용 전 확인 게이트의 상태.
interface PendingCreate {
  title: string;
  description: string;
  projectId: string;
  projectPath: string;
  createdAt: number;
}
const pendingByChannel = new Map<string, PendingCreate>();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10분 후 만료(stale 확인 방지)

// ★한글 안전 경계: JS `\b`(ASCII 워드경계)는 한글 뒤에서 매칭 실패("네\b" → 매칭 안 됨).
//   그래서 토큰 뒤를 공백/문장부호/문자열끝으로 명시 경계 처리한다.
function isAffirmative(t: string): boolean {
  return /^(네|예|응|어|그래|좋아요|좋아|맞아요|맞아|맞습니다|확인|진행|추가|okay|ok|yes|yep|sure|go|y)([\s.,!~]|$)/i.test(
    t.trim(),
  );
}
function isNegative(t: string): boolean {
  return /^(아니요|아니오|아니|취소|nope|no|싫어|싫|말아|하지마|stop|cancel|n)([\s.,!~]|$)/i.test(t.trim());
}

// ── 빠른 단발 LLM(claude --print) — ★PTY 무관, 바쁜 Super Agent 와 격리 ──
function runClaudePrint(prompt: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolved = resolveClaudeBinaryPath();
    if (!resolved.ok || !resolved.path) {
      reject(new Error(resolved.error || 'claude binary not found'));
      return;
    }
    const child = spawn(resolved.path, ['--print', prompt], {
      cwd: DATA_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude --print timed out'));
    }, timeoutMs);
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude --print exit ${code}: ${err.slice(0, 200)}`));
    });
  });
}

function extractJson(raw: string): unknown | null {
  // 모델이 코드펜스/잡음을 섞어도 첫 JSON 오브젝트만 추출.
  const fenced = raw.replace(/```json\s*|\s*```/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function parseKanbanIntent(text: string): Promise<KanbanIntent | null> {
  const prompt =
    'You parse a Korean kanban request into JSON. Respond ONLY with one JSON object, no markdown, no prose. ' +
    'Schema: {"action":"create"|"other","title":string,"description":string,"project":string|null}. ' +
    'If the user wants to ADD or create a NEW task, action="create". ' +
    'If they want to modify/delete/reprioritize an existing task, or it is not a task request, action="other". ' +
    'Extract a concise Korean title and a one-line description. ' +
    'project = a project name if clearly mentioned (e.g. triplan, frontend, backend, bueongi), else null. ' +
    `User request: "${text.replace(/"/g, "'")}"`;
  try {
    const raw = await runClaudePrint(prompt);
    const obj = extractJson(raw) as Partial<KanbanIntent> | null;
    if (!obj || (obj.action !== 'create' && obj.action !== 'other')) return null;
    return {
      action: obj.action,
      title: (obj.title || '').toString().trim(),
      description: (obj.description || '').toString().trim(),
      project: obj.project ? obj.project.toString() : null,
    };
  } catch (e) {
    console.error('[slack-kanban] parseKanbanIntent failed:', e);
    return null;
  }
}

// ── 칸반 직접 create(IPC 우회, kanban-handlers 의 create 로직 미러) ──
//   export — 슬랙 "task" 명령(slack-bot handleSlackCommand)에서도 재사용.
export function createTaskDirect(params: {
  title: string;
  description: string;
  projectId: string;
  projectPath: string;
}): { id: string; title: string } {
  let tasks: Array<Record<string, unknown>> = [];
  try {
    if (fs.existsSync(KANBAN_FILE)) tasks = JSON.parse(fs.readFileSync(KANBAN_FILE, 'utf-8'));
  } catch {
    tasks = [];
  }
  const backlog = tasks.filter(t => t.column === 'backlog');
  const maxOrder = backlog.length > 0 ? Math.max(...backlog.map(t => (t.order as number) ?? 0)) : -1;
  const now = new Date().toISOString();
  const newTask: Record<string, unknown> = {
    id: uuidv4(),
    title: params.title,
    description: params.description,
    column: 'backlog',
    projectId: params.projectId,
    projectPath: params.projectPath,
    assignedAgentId: null,
    agentCreatedForTask: false,
    requiredSkills: [],
    priority: 'medium',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    order: maxOrder + 1,
    labels: ['slack'],
    attachments: [],
  };
  tasks.push(newTask);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KANBAN_FILE, JSON.stringify(tasks, null, 2));
  return { id: newTask.id as string, title: params.title };
}

/**
 * #-tasks 채널 메시지 처리(2-A: create 전용, ★적용 전 확인).
 *
 * @param onTaskCreated 생성된 task 를 UI/구독자에 알리는 콜백(emitTaskEvent 래퍼). 선택.
 */
export async function handleTasksChannelMessage(
  channel: string,
  text: string,
  say: (msg: string) => Promise<unknown>,
  _appSettings: AppSettings,
  onTaskCreated?: (task: Record<string, unknown>) => void,
): Promise<void> {
  const trimmed = (text || '').trim();
  if (!trimmed) return;

  // 1) 보류 중인 확인이 있으면 먼저 처리.
  const pending = pendingByChannel.get(channel);
  if (pending) {
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      pendingByChannel.delete(channel);
      // 만료 — 아래에서 새 요청으로 재파싱.
    } else if (isAffirmative(trimmed)) {
      pendingByChannel.delete(channel);
      try {
        const created = createTaskDirect(pending);
        onTaskCreated?.({
          id: created.id,
          title: pending.title,
          description: pending.description,
          column: 'backlog',
          projectId: pending.projectId,
          projectPath: pending.projectPath,
        });
        await say(`:white_check_mark: 추가됨 — *${pending.title}*  \`${pending.projectId}\` (#${created.id.slice(0, 8)})`);
      } catch (e) {
        await say(`:x: 추가 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    } else if (isNegative(trimmed)) {
      pendingByChannel.delete(channel);
      await say(':wastebasket: 취소했어요. 다시 말씀해 주세요.');
      return;
    } else {
      // 긍정/부정이 아니면 → 새 요청으로 간주하고 기존 보류 폐기 후 재파싱.
      pendingByChannel.delete(channel);
    }
  }

  // 2) 의도 파싱(빠른 단발 LLM).
  const intent = await parseKanbanIntent(trimmed);
  if (!intent) {
    await say(':warning: 지금은 요청을 이해하지 못했어요(파싱 실패). 잠시 후 다시 시도하거나 더 명확히 적어주세요.');
    return;
  }

  // 3) create 외 동작은 거부(2-A 범위 — Slack B 게이트로 미룸).
  if (intent.action !== 'create') {
    await say(
      ':information_source: 지금은 *추가(create)* 만 지원해요. 수정·삭제·우선순위 변경은 인증 게이트가 필요해 추후 지원합니다.',
    );
    return;
  }

  // 4) 필수값(title) 모호 → 되묻기(추측 생성 금지).
  if (!intent.title) {
    await say(':question: 어떤 작업을 추가할까요? 제목을 한 줄로 알려주세요.');
    return;
  }

  // 5) ★적용 전 확인: 보류에 저장하고 사람 승인 대기.
  const proj = resolveProject(intent.project);
  pendingByChannel.set(channel, {
    title: intent.title,
    description: intent.description || intent.title,
    projectId: proj.id,
    projectPath: proj.path,
    createdAt: Date.now(),
  });
  await say(
    `:memo: 이렇게 추가할게요:\n` +
      `• 제목: *${intent.title}*\n` +
      `• 프로젝트: \`${proj.id}\`\n` +
      (intent.description ? `• 설명: ${intent.description}\n` : '') +
      `\n맞으면 *"네"*, 아니면 *"아니요"* 라고 답해주세요.`,
  );
}

// 테스트/리셋용.
export function _clearPending(): void {
  pendingByChannel.clear();
}
