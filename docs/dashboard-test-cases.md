# Dorothy 대시보드 — 화면별 테스트 케이스 & 검증 결과

> 작성: 2026-06-07 / 범위: Dorothy 대시보드(:3500) 전 화면 + 데이터 API(:3500 /api/dorothy, electron :31415)
> 검증 방식: 라우트 로드(HTTP) + 주요 API 응답(HTTP/스키마). ※ UI 클릭/입력 등 인터랙션은 헤드리스로 자동검증 불가 → "수동확인" 표기.

## 요약
- 화면 라우트: **30/31 PASS(200)**, 1건 FAIL — `/integrations`(404, 독립 페이지 없음 → 현재 Settings 하위에만 존재)
- 데이터 API: **13/13 PASS(200)** + electron `:31415/api/agents` 200
- ⚠️ 시스템 이슈: 칸반 "done" ≠ 라이브 서비스 반영 (아래 "발견된 문제" 참조)

---

## 화면별 테스트 케이스

| # | 화면(route) | 목적 | 테스트 케이스 | 주요 API | 결과 |
|---|---|---|---|---|---|
| 1 | `/` 홈(ControlCenter) | 자동개발 관제 요약 | 로드 200 · 자동개발/에이전트/작업/막힘 카드 표시 · 한도 시 일시중지 배너 | agent-activity, provider-limit-state, kanban | ✅ 200 |
| 2 | `/agents` | 에이전트 레지스트리/운영 | 로드 · 11 baseline 표시 · fallback 패널(한도 시) · 스킬제안 패널 | agents, orchestrator-fallback, skill-proposals | ✅ 200 |
| 3 | `/agent-activity` | 에이전트별 작업 현황(카드) | 로드 · 11 에이전트 라이브 상태 · 최근 사이클(최신 틱) · 작업 클릭→워크플로우 | agent-activity | ✅ 200 (라이브 오버레이·cycles 최신화 수정 완료) |
| 4 | `/agent-workflows` | 에이전트 워크플로우 다이어그램 | 로드 · 에이전트 연결도 | agent-terminal-snapshots | ✅ 200 |
| 5 | `/kanban` | 칸반 보드 | 로드 · 작업 카드 · 단계 배지 · 카드 클릭→워크플로우 스테퍼 | kanban | ✅ 200 |
| 6 | `/runs` | 실행 기록(Run Board) | 로드 · run 목록 · RunDetail(steps/workflow/handoffs) | (electron runs) | ✅ 200 (run-kanban-sync로 채움) |
| 7 | `/sessions` | 터미널 세션(read-only) | 로드 · 에이전트 출력 | agent-terminal-snapshots | ✅ 200 |
| 8 | `/app-factory` | 앱 팩토리(프로젝트 캡슐) | 로드 · 생성 마법사 · env/메모 · 자율실행 토글 · GitHub 계정 | project-capsules, project-env, project-notes, companies | ✅ 200 |
| 9 | `/approvals` | 승인 대기 | 로드 · 승인 요청 목록 | approvals | ✅ 200 |
| 10 | `/companies` | 회사 레지스트리 | 로드 · 회사 목록 | companies | ✅ 200 |
| 11 | `/auto-company` | Auto-Company 상태 | 로드 · 데몬 상태 | auto-company | ✅ 200 |
| 12 | `/automations` | 자동화 규칙 | 로드 · 규칙 목록 | (electron) | ✅ 200 |
| 13 | `/recurring-tasks` | 반복 작업 | 로드 | (electron) | ✅ 200 |
| 14 | `/diagnostics` | 진단 | 로드 · 헬스/로그 | (electron) | ✅ 200 |
| 15 | `/harness` | 하네스(에이전트/스킬 설계) | 로드 · 하네스 현황 | harness | ✅ 200 |
| 16 | `/improvements` | 개선 신호 | 로드 · 신호 목록 | (electron) | ✅ 200 |
| 17 | `/skill-candidates` | 스킬 후보 | 로드 | (electron) | ✅ 200 |
| 18 | `/skills` | 스킬 목록 | 로드 | (electron) | ✅ 200 |
| 19 | `/plugins` | 플러그인 | 로드 | (electron) | ✅ 200 |
| 20 | `/templates` | 템플릿 | 로드 | (electron) | ✅ 200 |
| 21 | `/projects` | 프로젝트 개요 | 로드 | (electron) | ✅ 200 |
| 22 | `/reports` | 보고서 | 로드 · 역할별 보고서 | doc | ✅ 200 |
| 23 | `/vault` | 볼트(문서) | 로드 · 마크다운(표 렌더 수정됨) | doc | ✅ 200 |
| 24 | `/memory` | 메모리/지식그래프 | 로드 | (file) | ✅ 200 |
| 25 | `/usage` | 사용량 | 로드 · 사용량 차트 | (file) | ✅ 200 |
| 26 | `/pr` | PR | 로드 | (electron/git) | ✅ 200 |
| 27 | `/settings` | 설정(통합 포함) | 로드 · GitHub 웹훅/CLI/통합 | integrations | ✅ 200 |
| 28 | `/support` | 지원 | 로드 | - | ✅ 200 |
| 29 | `/whats-new` | 새 기능 | 로드 | - | ✅ 200 |
| 30 | `/pallet-town` | (월드/UI) | 로드 | world | ✅ 200 |
| 31 | `/tray-panel` | 트레이 패널 | 로드 | - | ✅ 200 |
| — | `/integrations` | 통합(독립) | 로드 | integrations | ❌ **404** — 독립 페이지 없음(Settings 하위에만 존재) |

## 데이터 API 검증 (GET)
agent-activity·agents·approvals·companies·kanban·orchestrator-fallback·provider-limit-state·skill-proposals·project-capsules·harness·integrations·auto-company·team-loop → **전부 200**. electron `:31415/api/agents` 200.

---

## 발견된 문제 / 미구현·미반영

1. **`/integrations` 라우트 404** — API(`/api/dorothy/integrations`)는 200이나 독립 화면 페이지가 없음. 메뉴/링크가 `/integrations`를 가리키면 깨짐. → 독립 페이지 추가 또는 Settings로 리다이렉트 필요.
2. **⚠️ "done" ≠ 라이브 반영 (시스템 이슈)** — 예: "여행 스타일 추천 구현" 칸반 done이나 실제 서비스 미반영. 원인:
   - 코드는 backend(`recommendation/ai/*`)·frontend(`AiItineraryScreen`/`api/recommendations`) 양쪽 존재하나 **backend 추천 코드가 미커밋**(워킹트리만, git 동결).
   - 라이브 백엔드(bootRun) **시작 20:57 < 코드 수정 21:09** → 라이브가 **옛 코드로 구동**(재기동 안 됨).
   - 즉 에이전트가 워킹트리 편집만으로 done 처리 → 커밋·재기동·재배포가 안 되어 **실제 서비스엔 안 나타남**. → done 기준에 "커밋 + 라이브 재기동 검증" 게이트 필요.

## 헤드리스 자동검증 한계(수동확인 필요 항목)
- 각 화면의 버튼/폼/모달 인터랙션, 실제 데이터 렌더링 정합, 드래그앤드롭(칸반), 차트 시각화 → 브라우저 수동 확인 필요.
- 라우트 200 = 페이지 로드 성공이며, 화면 내부 기능 동작까지 보장하지 않음.
