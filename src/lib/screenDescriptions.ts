/**
 * Phase 6-AH — 화면별 기능 설명(한글). 라우트 → 한 줄 설명.
 * ClientLayout 의 ScreenDescription 배너가 현재 경로에 맞춰 표시한다.
 * 가장 긴 접두사 우선 매칭(예: /runs/123 → /runs, /integrations/github 우선).
 */
export const SCREEN_DESCRIPTIONS: { prefix: string; title: string; description: string }[] = [
  { prefix: '/integrations/github', title: 'GitHub 연동', description: 'GitHub Webhook·토큰 설정 상태를 확인하고 owner/repo 등 비밀이 아닌 설정을 저장합니다. 토큰 값은 저장·표시하지 않습니다.' },
  { prefix: '/integrations/notifications', title: '알림 연동', description: 'Slack·KakaoTalk 알림 설정 상태를 확인하고 채널 등 비밀이 아닌 설정을 저장합니다. 카카오 개인 발송은 별도 설정이 필요합니다.' },
  { prefix: '/runs', title: '실행(Run)', description: '자동개발 Run을 생명주기 단계별로 보는 보드입니다. 실제 실행은 PM-tick→오케스트레이터→PTY 경로이며 Run 미러는 아직 미연결일 수 있습니다.' },
  { prefix: '/sessions', title: '세션', description: 'dorothy.db에 저장된 PTY/CLI 세션과 실제 PTY 기반 라이브 에이전트 터미널(읽기 전용·마스킹)을 봅니다.' },
  { prefix: '/pr', title: '풀 리퀘스트', description: 'GitHub Webhook으로 미러된 PR·CI 상태를 읽기 전용으로 추적합니다.' },
  { prefix: '/reports', title: '보고서', description: '에이전트가 생성한 결과 보고서·체인지로그·QA 리뷰·CI 요약을 최신순으로 모아 봅니다.' },
  { prefix: '/improvements', title: '개선 신호', description: 'QA/CI 실패·사용량 제한 등 Dorothy가 감지한 개선 신호를 분류하고 작업/스킬 후보로 전환합니다.' },
  { prefix: '/diagnostics', title: '진단', description: '실행 중 발생한 진단(오류·경고) 이벤트를 보고 개선 신호/스킬 후보로 전환합니다.' },
  { prefix: '/skill-candidates', title: '스킬 후보', description: '자기개선으로 수집된 스킬 후보를 검토하고 작업으로 전환합니다(스킬 파일 자동 생성은 없음).' },
  { prefix: '/companies', title: '회사', description: '듀얼엔진 회사(조직)와 프로젝트·에이전트 매핑을 관리합니다.' },
  { prefix: '/agents', title: '에이전트', description: '기준선 11개 에이전트의 상태·정의를 보고 등록/웜업/모델 설정을 관리합니다.' },
  { prefix: '/agent-workflows', title: '에이전트 워크플로우', description: '요청 접수→설계→검증→구현→QA→보고로 이어지는 프로세스 파이프라인을 다이어그램으로 봅니다.' },
  { prefix: '/templates', title: '템플릿', description: '자주 쓰는 작업·프롬프트 템플릿을 선택해 실행합니다.' },
  { prefix: '/kanban', title: '작업 보드(칸반)', description: '작업을 컬럼(backlog/planned/ongoing/done)으로 관리합니다. 프로젝트·담당 에이전트별로 필터링할 수 있습니다.' },
  { prefix: '/vault', title: '볼트', description: '에이전트 보고서·지식 베이스·노트를 열람·검색합니다(Obsidian 볼트 연동).' },
  { prefix: '/projects', title: '프로젝트', description: '자동개발 대상 프로젝트(triplan·dorothy)와 각 프로젝트의 에이전트·세션을 봅니다.' },
  { prefix: '/skills', title: '스킬', description: '에이전트 능력을 확장하는 스킬을 설치·연결·관리합니다.' },
  { prefix: '/plugins', title: '플러그인', description: '코드 인텔리전스·연동·워크플로우 플러그인을 둘러보고 설치·실행합니다.' },
  { prefix: '/recurring-tasks', title: '예약 작업', description: '에이전트가 수행할 반복·예약 작업을 시간대별로 관리합니다.' },
  { prefix: '/automations', title: '자동화', description: '외부 소스를 폴링해 조건 충족 시 에이전트를 자동 실행하는 규칙을 관리합니다.' },
  { prefix: '/usage', title: '사용량', description: '모델 토큰·비용 사용량 통계를 봅니다.' },
  { prefix: '/memory', title: '메모리', description: '에이전트 지식 그래프와 프로젝트별 메모리를 보고 편집합니다.' },
  { prefix: '/pallet-town', title: '클로드몬', description: '에이전트 활동을 게임형 월드로 시각화합니다.' },
  { prefix: '/auto-company', title: '오토컴퍼니', description: '24시간 자율 개발 루프를 시작/중지합니다(작업 내용은 보존).' },
  { prefix: '/agent-activity', title: '에이전트 작업', description: '에이전트별 작업·산출물·최근 터미널 출력 타임라인을 봅니다.' },
  { prefix: '/approvals', title: '승인 대기', description: '위험 작업(배포·push·secret·DB 등)의 승인 대기 큐를 검토합니다.' },
  { prefix: '/harness', title: '하네스', description: '.claude 에이전트·스킬 카탈로그와 팀 그래프를 보고 auto-company 스킬을 활성/비활성합니다.' },
  { prefix: '/app-factory', title: '앱 팩토리(나중)', description: '공공데이터 MVP 앱 후보를 계획 단계로만 관리합니다(후순위, 실제 생성 없음).' },
  { prefix: '/settings', title: '설정', description: '앱·엔진·알림·CLI 경로 등 Dorothy 환경설정을 관리합니다.' },
  { prefix: '/support', title: '지원', description: '도움말과 후원 정보를 봅니다.' },
  { prefix: '/whats-new', title: '새 소식', description: 'Dorothy의 릴리스 기록과 최근 개선 사항을 봅니다.' },
];

/** 현재 경로에 맞는 설명(가장 긴 접두사 우선). 루트('/')는 대시보드 자체 헤더가 있어 제외. */
export function screenDescriptionFor(pathname: string | null | undefined): { title: string; description: string } | null {
  if (!pathname) return null;
  let best: { prefix: string; title: string; description: string } | null = null;
  for (const e of SCREEN_DESCRIPTIONS) {
    if (pathname === e.prefix || pathname.startsWith(e.prefix + '/') || pathname.startsWith(e.prefix)) {
      if (!best || e.prefix.length > best.prefix.length) best = e;
    }
  }
  return best ? { title: best.title, description: best.description } : null;
}
