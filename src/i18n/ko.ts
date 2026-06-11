// Korean string table for Dorothy. Dependency-free, typed.
// Flat-ish nested map; access via i18n `t(key)` helper or directly.

export const ko = {
  nav: {
    dashboard: '대시보드',
    companies: '회사',
    agents: '에이전트',
    templates: '템플릿',
    kanban: '칸반',
    vault: '볼트',
    projects: '프로젝트',
    skills: '스킬',
    plugins: '플러그인',
    scheduled: '스케줄',
    automations: '자동화',
    usage: '사용량',
    memory: '메모리',
    claudeMon: '클로드몬',
    autoCompany: '오토컴퍼니',
    autoLoop: '자동 루프',
    approvals: '승인 대기',
    harness: '하네스',
    settings: '설정',
  },
  button: {
    start: '시작',
    stop: '중지',
    restart: '재시작',
    resumeAfterWait: '대기 후 재개',
    forceRun: '강제 실행',
    open: '열기',
    refresh: '새로고침',
    save: '저장',
    cancel: '취소',
    copy: '복사',
    copied: '복사됨',
  },
  status: {
    running: '실행 중',
    waiting: '대기',
    cooldown: '쿨다운',
    blocked: '차단',
    idle: '유휴',
    done: '완료',
    error: '오류',
    unknown: '알 수 없음',
  },
} as const;

export type KoStrings = typeof ko;
