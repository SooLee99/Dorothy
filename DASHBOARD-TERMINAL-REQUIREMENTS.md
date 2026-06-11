# 대시보드 에이전트 터미널 — 요구사항 정리 (2026-06-07)

사용자가 원하는 최종 상태를 기록한다. 이번 세션(Phase 6-S ~ 6-AG)에서 여러 번
구현 시도했으나 **사용자 화면에서 끝내 보이지 않아 대시보드 변경을 롤백**했다.
다음 시도 시 이 문서를 기준으로 다시 구현한다.

## 사용자가 원하는 것

1. **대시보드(`/`)에 "에이전트 터미널 보드"가 항상 보여야 한다.**
   - 기준선 프로세스 에이전트가 항상 슬롯/카드로 보임.
   - 기본 프로세스 8개 + 개발·검증 보조 3개(backend/frontend/security-reviewer) = 총 11개.
   - `agents.json`의 11개 기준선은 **그대로 유지**(삭제/축소 금지).
2. **각 에이전트의 실제 터미널(PTY) 출력**을 대시보드에서 볼 수 있어야 한다(슬롯/상태 표시가 아니라 진짜 출력).
   - 실행 중이면 **라이브 스트림**, 실행 중이 아니면 **마지막 세션 출력(스냅샷)**.
   - orchestrator가 PM-tick으로 실행되면 그 출력이 보여야 함.
3. **읽기 전용** 중심(입력/강제 start/강제 dispatch 없음).
4. orchestrator 실행 시 나머지 에이전트는 **위임형 유지**(전원 강제 실행 안 함 — 사용자 결정, 2026-06-06).
5. secret/token 마스킹 유지.

## 현재 미해결 (다음 시도에서 반드시 먼저 확인)

- **사용자 화면에서 보드/터미널이 안 보임.** 원인 미확정. 가능 원인:
  1. 사용자가 보는 창이 dev 대시보드(:3500/:31415)가 아니라 **패키지 release Dorothy.app(stale 빌드)** 일 수 있음 → 그 창엔 최신 UI가 없음. (6-AD에서 release GUI 종료했으나 재실행 가능.)
  2. dev 창이라도 컴포넌트가 화면 하단/스크롤 위치 등으로 안 보일 수 있음.
  3. 런타임 렌더 이슈 가능성(빌드/타입/테스트는 통과 — `next build` 성공, tsc 0, 테스트 39).
- **다음 시도 전 필수**: 사용자에게 **스크린샷** 요청 + 어느 창(dev vs release)을 보는지 확정. 필요하면 release 앱을 패키징(`npm run electron:build`)해 갱신하거나, 사용자가 dev 창/브라우저(http://127.0.0.1:3500)를 보도록 안내.

## 이번 세션에서 만든(롤백으로 미마운트된) 자산 — 재사용 가능

- `src/lib/agentProcessDisplay.ts`: CORE_PROCESS_AGENT_IDS(8)/AUXILIARY_AGENT_IDS(3)/ALL_OPERATION_AGENT_IDS(11), isCore/isAuxiliary/isOperationAgent.
- `src/lib/agentTerminalStatus.ts`: hasTerminal/terminalSlotStatus/buildTerminalSlots/summarizeSlots/maskLine/terminalLines/pickTerminalAgentId (순수, 테스트됨).
- `src/components/Dashboard/ProcessAgentTerminalBoard.tsx`: 8 core + 3 aux 슬롯 보드 + "터미널 보기".
- `src/components/Dashboard/DashboardLiveTerminal.tsx`: 가장 관련있는 에이전트 1개의 실제 터미널 상시 표시.
- `src/components/AgentTerminalPanel/index.tsx`: 실제 PTY output 읽기전용(라이브 `agent:output` IPC + 스냅샷 + 마스킹).
- `src/components/Dashboard/AllAgentsPanel.tsx`, `AgentTerminalOverview.tsx`.
- 데이터 경로(기존): electron `agent.list()`(output 포함) + `electronAPI.agent.onOutput`(라이브) + `/api/agents/:id/output`.

이 파일들은 디스크에 남아 있으나 `Dashboard/index.tsx`에서 **마운트 해제**됨(롤백). 원인 확정 후 다시 마운트하면 됨.

## 유지된(롤백하지 않은) 실제 수정 — 정상 동작 필요

- `agents.json` 11개 기준선(legacy UUID 0, codex+opus 0).
- PM-tick/team-orchestration repoint(레거시 UUID→slug), security-reviewer 등록.
- half-state 자동복구(start/check 스크립트), agent-manager output/skills 배열 초기화 가드, `/agents` undefined 가드(skills/projectPath).
- App Factory(계획전용).

## 빌드 메모

- 일반 `npx next build` 성공(API 라우트 유지).
- `ELECTRON_BUILD=1`(정적 export)은 기존 API 라우트 `/api/agents/[id]/stream`(SSE)와 비호환 → 정식 패키징은 `npm run electron:build`가 빌드 전 `src/app/api`를 임시 이동해 회피함.
