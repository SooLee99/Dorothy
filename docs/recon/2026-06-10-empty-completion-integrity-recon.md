# 빈 task_complete 무결성 방어 — 1단계 recon + 분기 확정 (read-only)

- **미션 ②**: 빈 완료(last_agent_message=null, ~3s)가 'done'으로 새는지 확인 → 차단(카나리·롤백) → running 고착 회수.
- **모드**: recon-first, 측정한 것만, 무결성 우선, bad-news-exit. 코드 변경 0(이 문서는 recon 산출물).
- **작성**: 2026-06-10 12:37 KST, orchestrator(active-real).
- **Dorothy HEAD**: `feature/dorothy-observability-phase0-2` @ `00bc117`(감지A).

---

## ★분기 확정: **B — 빈 완료는 Kanban 'done'으로 새지 않는다(고착만)**

근거(파일:라인 실측):

### 1) Kanban 'done'은 명시적 `mark_task_done` 호출로만 발생
- `electron/handlers/kanban-handlers.ts:405-408` — 워커 프롬프트에 *"you MUST call the `mark_task_done` MCP tool ... This will move the task to the Done column"* 주입. 즉 **done 전이는 에이전트가 직접 도구를 불러야** 일어남.
- 빈 완료 에이전트(codex balance=0): `last_agent_message=null`, ~3s, **도구 호출 0** → `mark_task_done`을 **부르지 않음** → done 전이 안 됨.

### 2) Run-상태 → Kanban-done 자동 브리지 없음
- `kanban-task-adapter.ts` 소비처는 `onKanbanTaskChanged`·`getRunForKanbanTask` **둘뿐**(= Kanban→Run 방향). Run 완료가 Kanban 보드를 done으로 쓰는 경로 **부재**.
- `orchestrator-service.ts` `advanceRun`(187~) 완료분기에 kanban 쓰기 grep **0건**.

### 3) 백스톱: done-gate.js가 증거없는 done을 신뢰 안 함
- `~/.dorothy/scripts/done-gate.js` — done 컬럼 태스크의 evidence(qa참여·체크리스트≥80%·라이브-반영 라벨·LLM 명시 evidence)를 `done-criteria.js`로 판정. `doneAllowed=false`면 **`검증대기-done` 라벨 + UNVERIFIED_DONE 에스컬레이션**. (자동 reopen은 안 함 — thrash 방지.)
- `done-criteria.js` — owner별 머신증거 요구: backend=`test|build` 명령, qa-reviewer=`testCount>0`, devops-reporter=`reportPath`. 미충족=PREVIEW(=done 불가 신뢰).
- → **빈 완료가 가령 done에 도달해도 done-gate가 검증대기로 강등**. 이중 방어.

### 4) 경험적 확증
- 빈완료한 codex 에이전트(qa-reviewer #53 등)는 **'ongoing'에 멈춤**(QA-T54 ongoing 10% 유지), **done 아님**. 관측 = 고착(B), 누출(A) 아님.

> **결론: A(샌다) 아님 → B(고착만). 사용자가 우려한 "빈완료→칸반 done" 무결성 구멍은 실측상 존재하지 않음.**

---

## ★과거 "가짜 done" 식별 (목록만 — 되돌리기 금지, 사람 결정)
- done-gate 기존 state `state/done-gate.json` `flagged[]` = **238건**이 이미 `검증대기-done`으로 식별됨.
- 단 ★이들은 **빈완료 누출이 아니라 "주장만(unverified-claim)"** — 실제 작업됐으나 done-gate의 evidence 합성이 머신증거를 확인 못 한 케이스(예 `c500a04d` FE-FROMURL-ID-DOUBLE-PREFIX = 실제 프론트 수정, `827566ed`, `a9f1c671`, `8ae36c90` 등 최근 UNVERIFIED_DONE).
- **빈완료(last_agent_message=null)로 인한 가짜 done = 0건**(위 분기 B로 구조적으로 불가). 238건은 별개 이슈(evidence 합성 약함 → 보수적 over-flag, 무결성 측엔 안전).
- ⚠️ 238건 자동 되돌리기 **금지**(미션 규율). 식별·보고만.

---

## ★잠재 갭 (정직 — Kanban 아닌 orchestrator Run 레이어)
- `electron/services/api-routes/hooks-routes.ts:216-227` — status hook이 `idle`/`completed`를 받으면 **무조건** `endAgentSession({endStatus:'completed'})` + `completeRunStep({runStepId, endStatus:'completed'})`. **산출물/last_agent_message 검증 없음.**
- 즉 Plan 기반 Run의 RunStep이 빈 턴에도 'completed'로 전이될 수 있음(= Run 레이어 G1 역방향 위험). 단:
  - (a) **Kanban 보드 done은 안 씀**(위 2). 영향은 내부 Run 모델 진행뿐.
  - (b) **구분 신호 부재**: hooks-routes는 status POST만 받음. Dorothy 전체에 `last_agent_message` 참조 **0건** — 빈완료를 정상완료와 구분할 신호가 **완료-판정 지점에 없음**.
  - (c) **codex는 이 hook을 안 쏠 가능성**: `codex-runtime-service.ts`는 status hook 미전송(라이브 세션 추적만). 빈완료 codex는 이 경로 자체를 안 탈 수 있음.

---

## ★2단계 결정: **보류(HOLD) — 위험한 완료-판정 변경 강행 안 함**
미션 규율 인용: *"빈 완료를 정상 완료와 못 가름(기준 불충분) → 2단계 보류 + '구분 기준 미확정' 정직 보고(오판 위험 있는 차단 금지)."*

적용:
1. **긴급 전제 거짓**: 빈완료→done 누출은 B로 실측상 없음. Kanban은 mark_task_done 게이트 + done-gate 백스톱으로 이미 이중 보호. → ②의 긴급도 소멸.
2. **결정 지점에 구분 신호 부재**: 완료-판정(hooks-routes/completeRunStep)에서 `last_agent_message=null`을 못 봄. 여기서 차단하면 **정상 완료를 실패로 오판할 위험** → 무결성보다 가용성 해침.
3. 따라서 카나리 없는 완료-판정 코드 변경 **금지**. 안전한 길은 아래 설계를 사용자 게이트 후 별 PR로.

### 안전한 ②/③ 설계 제안 (게이트 후, 카나리·롤백 포함)
- **신호 표면화 먼저(2의 선결)**: codex rollout(`~/.codex/sessions/.../rollout-*.jsonl`)의 `task_complete.last_agent_message`/`duration_ms`/`rate_limits.credits.balance`를 Dorothy가 읽어 세션에 `emptyCompletion:true` 플래그로 노출(감지A 옆에 관측자로 추가, read-only).
- **2단계(완료-판정, 카나리)**: `emptyCompletion && duration<Ns && 도구호출 0 && 산출물 0`인 경우에만 `completeRunStep`을 `endStatus:'failed'`(needs_fix)로. **엄격 AND 조건**으로 정상완료 오판 0. 1개 에이전트(또는 그림자 비교)부터 → 환경 플래그 `EMPTY_COMPLETION_GUARD`로 즉시 롤백.
- **3단계(고착 회수)**: 감지A가 이미 MCP↔disk 불일치를 *알림*만 함 → 회수기가 그 슬롯의 MCP running을 disk 실상태(idle)로 정정. **active-real(orchestrator) 제외**, 무진행+빈완료만. 완료-판정 무관(상태 정정만)이라 ②보다 저위험 → 우선 후보.

---

## 성공기준 대비 (미션 §6)
- [x] 1단계: 빈완료가 done으로 새나(A)/고착만(B) **확정 = B** + 과거 가짜done 식별(238 검증대기-done, 단 빈완료-누출 0).
- [HOLD] 2단계: 빈완료 done처리 0은 **이미 충족(B)**. 차단 코드 변경은 신호 부재로 보류(오판 방지).
- [제안] 3단계: 회수기 미구현 — 감지A는 알림만. 저위험이라 게이트 후 우선.
- [x] dispatch/할당 변화 0. 코드 변경 0(recon만). 측정한 것만.

## 메타
- read-only 준수: done-gate 라이브 실행 안 함(라벨 쓰기 회피) — 기존 state만 read. 코드 0수정.
- secret: balance 등 수치만, raw secret 없음.
- 미확정: codex가 status hook을 실제 쏘는지(Run-layer 발동 여부)는 코드상 미전송으로 보이나 100% 단정은 미확정(PTY/main.ts 경로 추가확인 여지). Kanban 분기 B 결론은 이와 무관하게 견고(mark_task_done 게이트).
