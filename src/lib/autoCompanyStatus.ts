// 오토컴퍼니(자동 개발 루프)의 기술 상태를 누구나 이해할 수 있는 한국어 한 줄 상태로 변환.
// auto-company 페이지와 대시보드 카드가 함께 사용한다.

export type AutoTone = 'running' | 'resting' | 'stopped' | 'blocked' | 'error' | 'unknown';

export interface PlainStatus {
  tone: AutoTone;
  emoji: string;
  headline: string; // 한 줄 요약 (쉬운 말)
  detail: string; // 보조 설명
}

export interface AutoStateInput {
  state?: Record<string, string> | null;
  paused?: boolean;
  pidAlive?: boolean;
  dorothyBusy?: boolean; // Dorothy 에이전트가 작업 중이라 데몬이 양보하는 상황
}

// tone → Tailwind 색상 클래스 (배지/배경)
export const toneClasses: Record<AutoTone, { text: string; bg: string; dot: string }> = {
  running: { text: 'text-green-600 dark:text-green-400', bg: 'bg-green-500/10 border-green-500/30', dot: 'bg-green-500' },
  resting: { text: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/30', dot: 'bg-yellow-500' },
  stopped: { text: 'text-muted-foreground', bg: 'bg-secondary border-border', dot: 'bg-gray-400' },
  blocked: { text: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/10 border-red-500/30', dot: 'bg-red-500' },
  error: { text: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-500/10 border-orange-500/30', dot: 'bg-orange-500' },
  unknown: { text: 'text-muted-foreground', bg: 'bg-secondary border-border', dot: 'bg-gray-400' },
};

export function plainAutoStatus(input: AutoStateInput): PlainStatus {
  const state = input.state ?? {};
  const s = (state.STATUS ?? '').toLowerCase();
  const loop = state.LOOP_COUNT ?? state.CYCLE;
  const last = state.LAST_RUN;
  const lastPart = last ? `마지막 작업: ${last}` : '';
  const loopPart = loop ? `지금까지 ${loop}번 작업했어요. ` : '';

  // 1) 일시정지(실제 멈춤)가 최우선 — 상태파일 STATUS 보다 정확
  if (input.paused) {
    return {
      tone: 'stopped',
      emoji: '⏸️',
      headline: '멈춰 있어요',
      detail: '“시작” 버튼을 누르면 자동 개발이 다시 시작돼요.',
    };
  }

  // 1.5) Dorothy 에이전트에 양보 중 (상호 배제)
  if (input.dorothyBusy || s.includes('yield')) {
    return {
      tone: 'resting',
      emoji: '🤝',
      headline: 'Dorothy 에이전트에 양보 중',
      detail: 'Dorothy 에이전트가 작업 중이라 자동 루프가 잠시 멈춰 기다려요. 작업이 끝나면 자동으로 다시 시작해요.',
    };
  }

  // 2) 안전장치로 자동 멈춤
  if (s.includes('circuit') || s.includes('block')) {
    return {
      tone: 'blocked',
      emoji: '🔴',
      headline: '연속 실패로 자동 멈췄어요',
      detail: '안전장치가 작동했어요. 로그를 확인하고 다시 시작해 주세요.',
    };
  }

  // 3) 사용량 한도로 쉬는 중
  if (s.includes('cooldown') || s.includes('wait') || s.includes('limit')) {
    return {
      tone: 'resting',
      emoji: '😴',
      headline: '잠시 쉬는 중이에요',
      detail: '사용량 한도에 걸려 자동으로 기다렸다가 다시 시작해요. (한도를 우회하지 않아요)',
    };
  }

  // 4) 실행 중 (프로세스 생존이 확인되면 더 확실)
  if (s.includes('run')) {
    return {
      tone: 'running',
      emoji: input.pidAlive === false ? '🟡' : '🟢',
      headline: input.pidAlive === false ? '실행 상태로 표시돼요 (확인 필요)' : '자동 개발이 돌아가는 중이에요',
      detail: `${loopPart}${lastPart}`.trim() || '작업을 진행하고 있어요.',
    };
  }

  // 5) 오류
  if (s.includes('error') || s.includes('fail')) {
    return {
      tone: 'error',
      emoji: '⚠️',
      headline: '최근 작업에 오류가 있었어요',
      detail: '로그를 확인해 보세요. 다시 시작하면 이어서 진행해요.',
    };
  }

  // 6) 정지/완료/대기
  if (s.includes('idle') || s.includes('done') || s.includes('complete') || s.includes('stop') || !s) {
    return {
      tone: 'stopped',
      emoji: '⏸️',
      headline: '멈춰 있어요',
      detail: '“시작” 버튼을 누르면 자동 개발이 시작돼요.',
    };
  }

  return { tone: 'unknown', emoji: '❔', headline: '상태를 알 수 없어요', detail: '새로고침을 눌러 다시 확인해 보세요.' };
}
