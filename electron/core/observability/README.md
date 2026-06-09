# Phase 0 — 백엔드 실측 신호 (observability)

대시보드 전에 "진짜 도는지(B1)"·"한도가 진짜인지(B3)"를 *관측된 사실*로 노출한다.
북극성: **주장 아니라 실측. 모르면 `observed:false` — 절대 '실행 중/가용'으로 칠하지 않는다.**

## PR-0-common — 공통 유틸 (read-only, 순수 모듈)

| 모듈 | 역할 |
|---|---|
| `server-clock.ts` | `serverNow()` — 부팅 wall-clock + `process.hrtime` 단조 경과. **역행하지 않는** epoch. `meta.serverNow` 기준. |
| `observed.ts` | `observed(payload)` / `unknown(reason)` / `observedOr(...)`. ★낙관 기본값 금지 — 모르면 `unknown`. reason ∈ `not-implemented\|source-missing\|probe-pending\|stale\|mapping-uncertain`. |
| `envelope.ts` | `{ meta:{serverNow,generatedAt,sources,partial}, data }` 빌더. 신규 신호 라우트 전용(기존 평면 응답과 공존). |
| `secret-mask.ts` | `maskSecrets(line, knownValues?)` — 보수적 과마스킹. |

### ⚠️ 마스킹 한계 (§1.2 출구 — recon 축 E)
- **(1) 알려진 값 매칭은 불가**: 이 프로세스가 secret 실제 값 집합을 마스킹 함수에 주입하는 설계상 경로가 없다(`maskLine`/`maskSecrets`는 `appSettings` 미접근). `VALUE_MATCHING_ENABLED === false`.
- 실사용은 **(2) env 대입 라인 + (3) 토큰 패턴**만 + **과마스킹 강화**(Bearer/sk-/ghp_/github_pat_/xox/glpat/AWS AKIA/JWT/Telegram bot token).
- `knownValues` 인자는 테스트/미래용(값 소스가 배선되면 (1) 활성). 평문 그대로의 임의 secret은 패턴에 안 걸리면 **가려지지 않을 수 있다**(정직한 한계).

## PR-0a — B1 계측 + 세션 신호 (read-only, ★0a에서 멈춰도 됨)

`session-metrics.ts` — PTY onData 4지점(`agent-manager.initAgentPty`, `ipc-handlers` agent:create/start, `api-routes` /start)에서 **O(1) 계측**:
`byteCount += utf8len`, `lineCount += newlines`, `lastOutputAt = serverNow()`. ★디스크 I/O 없음(메모리 Map, AgentStatus 미오염).

### 엔드포인트
```
GET /api/sessions                  → baseline 11 세션 신호
GET /api/sessions/{id}/output      → 마스킹된 tail-only 출력
```
(Next 프록시: `GET /api/dorothy/sessions`, `/api/dorothy/sessions/{id}/output` → electron :31415)

### ⚠️ B1 한계 (필드명에 반영됨)
- `byteCount` 증가 = **'프로세스 생존 + 출력'까지**. **'유의미 전진'이 아니다**(무한 루프가 에러를 토해도 증가).
- 그래서 `derived.outputActivity` 는 **`recent` | `silent`** 만(★`advancing`/`progress` 금지).
  `recent` = `secondsSinceLastOutput < 30`(`OUTPUT_IDLE_SECONDS`). net-progress 판정은 이후 Phase.
- 응답에 **`running:true` 류 필드를 두지 않는다** — 생존은 `pty.alive`(=`ptyProcesses.has`) 실측만.

### ⚠️ observed:false 가 영구인 것 (§1.2 출구)
- **`taskId`**: `mapping-uncertain` ★영구. recon 축 C — `currentTask`는 자유문자열이고 kanban 존재 검증 경로가 없어 §1.3 (b)(c) 미충족.
- **`cursor`**: `not-implemented`. output buffer가 단조 idx를 안 줘서 증분(since={idx}) 불가 → **tail-only**(`?lines=`). 증분은 ring-buffer 재설계 후속 Phase.
- `lastOutputAt`/`output`/`pty.pid`: 해당 PTY가 계측 경로로 떠 있을 때만 `observed:true`(아니면 `probe-pending`/`source-missing`).

### 관측 수단 (대시보드 없이)
```bash
TOKEN=$(cat ~/.dorothy/api-token)
curl -s localhost:31415/api/sessions -H "Authorization: Bearer $TOKEN" \
 | jq '.data.sessions[] | {agentId, alive:.pty.alive, act:.derived.outputActivity, sec:.derived.secondsSinceLastOutput, bytes:.output.byteCount}'
# PTY hang 유발 → watch 로 recent→silent 전이·sec 증가를 눈으로 확인
```

## PR-0b — provider 한도 신호 (read-only, ★dispatcher 미변경)

`provider-signal.ts`(순수 상태 도출) + `providers-routes.ts`(수집).
```
GET /api/providers   (Next 프록시: /api/dorothy/providers)
→ data.providers[]: { name, state, predicted{observed}, probe{observed} }
```
- **predicted** = `~/.dorothy/runtime/provider-limit-state.json` `{limited, cooldownUntil}`(authoritative 예측).
- **probe(real-call)** = ① 그 provider 에이전트 세션이 최근(<30s) 출력 중 → `result:ok`(session-activity, 부작용0) ② `rate_limit_events` active → `result:limited` ③ 없음 → `observed:false(probe-pending)`.
- **state**: `probeOk→available` / `probeLimited→limited` / `predLimited→(recoveryAt?recovering:limited)` / `else→unknown`.

### ⚠️ 불변식 + 조사 분기(A/B)
- **available 은 실측 ok(probeOk)일 때만**. 예측 recoveryAt 도달만으론 금지. 예측 limited 라도 실측 ok 면 available(실측 우선).
- **CLI probe A/B**: claude/codex 는 `--version` 류 호출이 가능(A)하나, 한도 health 를 보려면 세션을 띄워야 해 비용·부작용이 있다. → ★채택 = **real-call 재사용**(메인): 이미 실행 중인 세션의 출력 활동(`session-metrics`)을 ok 신호로, `rate_limit_events`(usage-limit-parser 가 PTY 출력 파싱→DB 기록)를 limited 신호로 쓴다. **mini-probe(`--version`) 는 미구현**(real-call 로 충분, 토큰/세션 비용 0).
- ★provider-limit-state 의 engine 라벨은 codex 한도를 claude 로 오라벨할 수 있음 → predicted 는 authoritative 파일을, probe limited 는 engine 필터(참고)로. available 판정은 engine 라벨과 무관한 session-activity(실측)에만 의존.
- **dispatcher 미변경** — 판정을 어디에도 적용하지 않음(노출만). 적용은 PR-0c(그림자→카나리→확대).

## 런타임 반영
코드는 read-only·additive. 런타임에 태우려면(★사용자 승인 영역):
```
npx tsc -p electron/tsconfig.json && launchctl kickstart -k gui/$(id -u)/com.dorothy.dashboard
```
재시작 없이 코드/단위테스트만으로 **0a에서 멈춰도 가치 있음**(B1 데이터의 *코드*는 확보).

## 테스트
```
npx vitest run __tests__/electron/observability-common.test.ts __tests__/electron/session-metrics.test.ts
```
(전체 `__tests__/electron` 다수 실패는 기존 electron 싱글톤 테스트 격리 문제 — 본 모듈과 무관, 단독 실행 시 통과)
