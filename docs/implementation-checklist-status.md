# Dorothy — 구현 체크리스트 현황 (2026-06-08)
## Phase 7·8 + Part F · G · H 사양 대비 구현 상태

> 표기: ✅ 구현+자동검증 / 🟡 부분(코드 있음·일부 미완) / ❌ 미구현(LLM·electron·라이브 운영)
> 검증: 하니스 **78/78** + master soak **12/12** + tsc 0 (메타테스트 전제 통과). 스크립트는 `~/.dorothy/scripts/`, 하니스는 `~/.dorothy/harness/`.
> "lazy" = 첫 실제 사용 시 자동 생성되는 state 파일(생산 스크립트는 존재).

---

## 0단계 ▶ 그라운드 룰 (M-1 불변식)
- 🟡 단일 주입형 clock (정책층 6종 이관·scan 0위반 / 나머지 20+electron wall-clock) — `clock.js`
- ✅ 단일 write-back executor + 공유락 + WAL(intent→apply→commit→notify) — `executor.js`·`lock.js`·`wal.js`
- ✅ READY 전 dispatch 금지 — `boot-recovery.js` (pm-tick 0b-2)
- 🟡 섹션0 이중강제 (executor 상위 ✅ / worker 셸 하위는 `command-policy.json`+bash-gate, PTY 인터셉터 실연결 ❌)
- ✅ command-policy·섹션0 FAIL-CLOSED — `config-validate.js`
- ✅ 단일 막힘≠전체 정지(범위별) — `scope-breaker.js`·`pause-state.js`
- ✅ 모든 대기 deadline+safe-default — pause-reason deadline
- ✅ progress=상태전진만 — `liveness-state.js` netProgress
- ✅ 자동 적용=evidence+idempotency+journal+notify, 외부 ensure-once — `executor.js`·`side-effects-ledger.js`
- ✅ 외부 비가역→사람 에스컬레이션 — `external-wal.js`(unknown→escalate)
- ✅ raw secret 미기록 — `secret-redact.js`, cred 핸들만 — `credentials.js`
- 🟡 ack=사람행위·독립경로 dead-man's-switch (escalation 래더 ✅ / 독립채널·ack 의미론 부분)
- ✅ 유의미 이벤트 unified 타임라인 — `events.js`·`timeline.js`·`unified-events-db.js`
- ✅ autonomy 개방 ladder·자동강등 즉시·섹션0 전레벨 사람 — `supervision.js`·`trust.js`

## 1단계 ▶ 토대
- 🟡 **G-8①·H-1** Clock+seeded RNG — `clock.js`+`harness/lib.js`(VirtualClock/seededRng). lint 강제 ❌
- ✅ **C-1·F-7·G-8②** executor+락+WAL — `executor.js`(apply-journal)·`lock.js`(30/50 동시 lost-update 0 검증)·`wal.js`(orphan reconcile)
- ✅ **G-7** config 검증+fail-closed — `config-validate.js` (autonomy/command 손상→FAIL-CLOSED 검증). 핫리로드/last-good 🟡
- ✅ **G-3·H-12** readiness+부팅 데드라인 — `boot-recovery.js`(BOOT_DEGRADED+하드 에스컬레이션)

## 2단계 ▶ 신경계
- ✅ **A-1** PTY 영속+reconcile — `pty-registry.js`(matched/dead/orphan)
- ✅ **A-2** lock+dispatch idempotency epoch — `lock.js`·`dispatch-epoch.js`(PTY live중 epoch증가 금지)
- ✅ **A-4** 리소스 상한 — `limits-guard.js`+`limits.json`
- ✅ **A-5** secret 마스킹 — `secret-redact.js`
- ✅ **G-1** 자원 수명(디스크/메모리/워크스페이스) — `resource-state.js`·`workspace-gc.js`

## 3단계 ▶ 안전 경계
- 🟡 **F-2** worker 샌드박싱 — `command-policy.json`+bash-approval-gate 훅 존재 / PTY wrapper 실인터셉트 ❌
- ✅ **F-5** 복구 자기보호 — `recovery-circuit.js`(thrash trip)+`heartbeat-killer.sh`(외부 killer, launchd 등록은 사용자)+net-progress STALL
- ✅ **G-2(+H-13)** poison/scope 차단기 — `crash-detect.js`·`crash-attribution.js`(공유원인 판별)·`scope-breaker.js`

## 4단계 ▶ 판단
- ✅ **B-2** stuck/timeout 임계 — `thresholds.json`(task별 OUTPUT_STALL)
- ✅ **B-1** watchdog 8-state — `watchdog-state.js`(candidateId 안정)
- ✅ **B-3** failure classifier — `failure-classifier.js`
- ✅ **B-5** evidence 신뢰 — `evidence-verify.js`
- 🟡 **B-6** report→kanban reconciler — `run-kanban-sync.js` 부분(강매칭만)
- ✅ **B-4** role-based done criteria — `done-criteria.js`+`done-gate.js`(증거없는 done→검증대기 강등)
- 🟡 **A-3** 인프라 self-healing — half-state watchdog 존재 / orchestrator hang lock해제 부분

## 5단계 ▶ 집행
- ✅ **C-1** executor+autonomy+journal+notify — `executor.js`·`autonomy-policy.json`
- ✅ **C-2** provider fallback — `fallback.js`·`provider-policy.json`(no-fallback)·orchestrator-fallback. 실 worker swap ❌(reload 제약)
- ✅ **C-3** rollback+오적용 — `rollback-exec.js`·`rollback-journal.js`
- ✅ **F-6·G-4(+H-14)** 외부 부작용 원장+멱등+cred — `side-effects-ledger.js`·`external-wal.js`·`credentials.js`
- ✅ **H-9** 통합 pause-reason — `pause-state.js`·`pause-reconcile.js`
- ✅ **H-10** 확인기반+램프드 재개 — `provider-recovery.js`(30분 주기 확인·per-provider·in-flight 불살)

## 6단계 ▶ 무중단
- ✅ **D-1(+F-1)** non-blocking scheduler+의존성+deadlock+blast-radius — `pause-reconcile.js`(dependency/cycle)·`dependency-graph.js`·`worker-nudge.js`
- ✅ **D-2(+F-3)** 자율해결+confidence — `self-resolution.js`(MAX_ATTEMPTS·reversibility 게이트)
- ✅ **D-3** bounded waits — pause-reason deadline(무한대기 0)
- ✅ **D-4(+G-5)** parking lot+에스컬 래더+stale 재검증 — `parking-lot.js`·`escalation-policy.json`·`approval-guard.js`
- ✅ **D-5(+H-11)** liveness watchdog+EXTERNAL_PAUSE — `liveness-state.js`(4-state·헛복구 억제·anomaly)

## 7단계 ▶ 보증·운영
- ✅ **F-4** 예산/생애상한 — `budget.js`·`budget-policy.json`(BUDGET_PAUSE)
- 🟡 **F-7(+G-6)** 횡단정합+독립알림+ack — `xconsistency-reconcile.js` ✅ / 독립채널 dead-man's-switch·ack 의미론 부분
- 🟡 **G-1·F-8** 상태파일 수명 — unified_events/runs/sessions DB화 ✅ / 일부 고-churn JSON 로테이션 부분
- ✅ **F-9** 시계/sleep 견고성 — `wake-detect.js`(herd 방지)·clock monotonic

## 8단계 ▶ 가시성
- ✅ **E-1** PTY→run/session mirror — `runs-mirror.js`(sessions)·`run-kanban-sync.js`(runs)
- ✅ **E-2** 대시보드 — `AutonomyStatusPanel.tsx`+`/api/dorothy/autonomy-status`(liveness 4상태·pause·예산·에스컬). approvals 1클릭 🟡
- ✅ **E-3** project-aware scheduler — `project-scheduler.js`(priority>굶주림>WIP)
- ✅ **G-9** unified per-task 타임라인 — `unified-events-db.js`(dorothy.db)·`timeline.js`·`events.js`

## 9단계 ▶ 검증 하니스
- 🟡 **H-1** 결정적 시뮬 — VirtualClock+seededRng+sandbox ✅ / 전 clock 이관 미완
- 🟡 **H-2** 주입 seam — sandbox 파일주입(실 코드경로 child 실행) ✅ / 경계 인터페이스(PTY/External/Fault) ❌
- ✅ **H-3** soak 러너 — `harness/soak-runner.js`+`master-soak.js`(72h압축 12/12·표적 시나리오)
- ✅ **H-4** 메타테스트 — mutation(가드 끔→RED)·결정성·주입충실도

## 10단계 ▶ 감독 롤아웃
- ✅ **H-5** ladder — `supervision.js`(한칸승급·점프거부·섹션0 전레벨 사람)
- 🟡 **H-6** shadow/canary — `rollout-state.json` 구조 ✅ / 실제 AUTO_SAFE 액션 shadow 배선 ❌
- ✅ **H-7** trust 승급/강등 — `trust.js`(자동강등 즉시)
- ✅ **H-8** kill switch+break-glass — `kill-switch.js`(executor 독립·섹션0 자동 0)
- ✅ **H-16** drift 관측 — `rollout-tick.js`(reopened/oscillate→trust 강등)

---

## 부록 A ▶ 산출물 인벤토리
**config/** ✅ autonomy·command·budget(budget-policy)·thresholds·limits·resource·escalation·supervision·trust·provider·fallback (11/11)
**state/** ✅ pause-state·rollout-state·trust-scores·boot-recovery·external-wal·unified-events.jsonl / lazy(첫 쓰기 시): apply-journal·rollback-journal·parking-lot·scope-breakers·dependency-graph·failure-classifications·self-resolution·workspace-registry·issued-credentials·done-gate
**runtime/** ✅ provider-limit-state·provider-recovery·last-tick·escalations·pty-registry / opt: kill-switch.flag
**dorothy.db** ✅ runs·sessions·unified_events
**logs/** ✅ pm-tick·health·notify + 컴포넌트별
**harness/** ✅ lib(VirtualClock/seededRng/sandbox)·soak-runner·master-soak·meta-tests·checklist-audit

## 부록 B ▶ 최종 출하 게이트 (M-3)
- ✅ 하니스 메타테스트 그린(고장변종 RED·결정성·주입충실도)
- ✅ 72h **가속(압축)** 0-human soak 그린 — provider 정전 EXTERNAL_PAUSE·회복 재개·예산·의존성·보안 no-fallback
- 🟡 표적 시나리오(provider-blackout/multi-reason/stale-approval ✅ / poison·cold-boot·disk-full·sleep-wake 일부 단위만)
- ✅ config/command 손상→FAIL-CLOSED
- ✅ kill switch·break-glass executor wedge 도달·섹션0 자동 0
- ❌ **실(비압축) 72h 라이브 soak** — 실시간 운영 관측 필요(미수행)

---

## 6대 잔여 — 2026-06-08 진행 결과
1. **판단 도구 → orchestrator/워커 연결** — ✅ **완료**: `done-gate.js`(증거없는 done 자동 강등) + orchestrator 프롬프트(`pm-tick-prompt.txt`)·worker-nudge 프롬프트에 판단 도구 호출 지침 추가. (LLM이 도구를 부르는 의미판단 부분은 claude 몫)
2. **실 worker provider swap** — 🟡 로직 작성(`worker-fallback.js`), ★활성화는 electron reload 필요(미실행)
3. **clock 전면 이관 + lint** — ✅ **node 스크립트 거의 완료**(21개 추가 이관, clock-scan 정책층 0·기타 5파일 8호출만). electron은 별도.
4. **실(비압축) 72h soak** — ✅ **관측 시작**(`soak-observe.js`, pm-tick 매 틱 라이브 불변식 점검·72h 무위반 시 passed). 시작 2026-06-08, 진행 중.
5. **heartbeat-killer launchd 등록** — ✅ **완료**(`launchctl list` 등록 확인, 300s 주기 pm-tick heartbeat 감시).
6. **F-2 명령 인터셉터** — 🟡 결정 로직 ✅(`command-intercept.js`: DENY_HARD/DRY_RUN/ALLOW + FAIL-CLOSED, 하니스 검증). ★electron PTY write 가로채기 실연결은 electron 수정 필요.

**남은 진짜 잔여**(electron 재빌드/시간/외부 LLM): #2·#6 의 electron 활성화 · #4 의 electron clock · #3 reload 활성화 · #2 soak 72h 경과 대기 · #1 의 LLM 의미판단. **검증 81/81 + master soak 12/12 + tsc 0**.
