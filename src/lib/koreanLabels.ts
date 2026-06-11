/**
 * Phase 6-N — centralized Korean labels for dashboard display.
 *
 * Display-only. Underlying enum *values* are never changed; these maps just
 * render them in Korean with an English fallback (`koLabel(map, value)`).
 */

import type {
  RunState,
  RunStepState,
  DispatchBlockerReason,
  AgentIdleReason,
} from '@/types/dorothy';

/** Generic safe lookup with English fallback. */
export function koLabel<T extends string>(map: Partial<Record<T, string>>, value: T | undefined | null): string {
  if (!value) return '';
  return map[value] ?? value;
}

export const RUN_STATE_KO: Record<RunState, string> = {
  created: '생성됨',
  planned: '계획됨',
  approval_required: '승인 대기',
  approved: '승인됨',
  running: '실행 중',
  verifying: '검증 중',
  needs_fix: '수정 필요',
  reporting: '보고 중',
  completed: '완료',
  blocked: '차단됨',
  failed: '실패',
  cancelled: '취소됨',
};

export const RUN_STEP_STATE_KO: Record<RunStepState, string> = {
  pending: '대기',
  running: '실행 중',
  completed: '완료',
  failed: '실패',
  skipped: '건너뜀',
  cancelled: '취소됨',
};

export const DISPATCH_BLOCKER_KO: Record<DispatchBlockerReason, string> = {
  no_pending_runstep: '할당 작업 없음',
  agent_not_registered: '미등록 에이전트',
  agent_not_live_loaded: '재로드 필요',
  agent_not_spawnable: '실행 불가',
  approval_required: '승인 필요',
  runmode_policy: '실행모드 정책',
  dependency_not_completed: '의존성 미완료',
  handoff_missing: '인계 문서 없음',
  rate_limited: '사용량 제한',
  auto_spawn_disabled: '자동 실행 꺼짐',
  provider_unavailable: '프로바이더 불가',
  claude_binary_missing: 'Claude 실행 경로 문제',
  project_path_missing: '프로젝트 경로 문제',
  mcp_config_missing: 'MCP 설정 없음',
  add_dir_missing: 'add-dir 경로 없음',
  launch_command_invalid: '실행 명령 오류',
  provider_model_mismatch: '프로바이더/모델 불일치',
  provider_unknown: '알 수 없는 프로바이더',
  model_missing: '모델 없음',
  codex_persistent_model_mismatch: 'Codex 저장 모델 비호환',
  stale_session_model_mismatch: '오래된 세션 모델 불일치',
  unknown: '미상',
};

export const IDLE_REASON_KO: Record<AgentIdleReason, string> = {
  active: '활성',
  no_assigned_runstep: '할당 작업 없음',
  waiting_for_approval: '승인 대기',
  blocked_by_rate_limit: '사용량 제한',
  blocked_by_runmode_policy: '실행모드 정책',
  waiting_for_dependency: '의존성 대기',
  waiting_for_handoff: '인계 대기',
  waiting_for_validation: '검증 대기',
  orchestrator_autospawn_disabled: '자동 실행 꺼짐',
  auto_resume_dry_run: '자동 재개(dry-run)',
  provider_unavailable: '프로바이더 불가',
  completed: '완료',
  unknown: '대기 중',
};

/** The 16-step process phase names used across the dashboard. */
export const PROCESS_PHASES_KO: string[] = [
  '요청 접수',
  '요구사항 정리',
  '설계·계획',
  '계획 검증',
  '승인 대기',
  '실행 준비',
  '계약/API 설계',
  '데이터베이스 검토',
  '프론트엔드 개발',
  '백엔드 개발',
  'QA·리뷰',
  '문서·보고',
  'PR·CI 확인',
  '진단·수정',
  '개선 후보 수집',
  '완료',
];

/**
 * Phase 6-AH — common dashboard UI strings (Korean). Display-only; use directly
 * (e.g. `UI_KO.viewOutput`) so frequently-seen English labels render in Korean.
 */
export const UI_KO = {
  liveAgentTerminalSessions: '라이브 에이전트 터미널 세션',
  viewOutput: '출력 보기',
  noRunsYet: '아직 실행 Run이 없습니다',
  runMirrorDisconnected: 'Run 미러 미연결',
  terminalSnapshot: '터미널 스냅샷',
  inputDisabled: '입력 비활성',
  readOnlyOutput: '읽기 전용 출력',
  noTerminal: '터미널 없음',
  ptyBased: 'PTY 기반',
  baseline: '기준선',
  liveTerminal: 'live terminal',
  readOnly: '읽기 전용',
  gracefulUnavailable: '일시적으로 사용할 수 없음',
  // status words
  running: '실행 중',
  waiting: '대기',
  idle: '유휴',
  blocked: '차단됨',
  ready: '준비',
  // integrations
  githubIntegration: 'GitHub 연동',
  notificationIntegration: '알림 연동',
  webhookStatus: 'Webhook 상태',
  configured: '설정됨',
  notConfigured: '미설정',
  webhookUrl: 'Webhook URL',
  testConnection: '연결 테스트',
  secretHiddenAfterSave: '토큰은 저장 후 다시 표시되지 않습니다',
} as const;

/** Status word → Korean (idle/running/waiting/...). */
export const AGENT_STATUS_KO: Record<string, string> = {
  running: '실행 중',
  waiting: '대기',
  idle: '유휴',
  completed: '완료',
  error: '오류',
  blocked: '차단됨',
  ready: '준비',
  unknown: '미상',
};

/** Map a RunState to its closest process phase label (for compact display). */
export function runStatePhaseKo(state: RunState): string {
  switch (state) {
    case 'created': return '요청 접수';
    case 'planned': return '설계·계획';
    case 'approval_required': return '승인 대기';
    case 'approved': return '실행 준비';
    case 'running': return '개발/실행';
    case 'verifying': return 'QA·리뷰';
    case 'needs_fix': return '진단·수정';
    case 'reporting': return '문서·보고';
    case 'completed': return '완료';
    case 'blocked': return '차단됨';
    case 'failed': return '실패';
    case 'cancelled': return '취소됨';
  }
}
