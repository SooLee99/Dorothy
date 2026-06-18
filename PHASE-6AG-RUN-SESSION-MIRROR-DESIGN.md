# Phase 6-AG — PTY Execution Mirror into Dorothy Run/Session Model (설계)

- 작성: 2026-06-07
- 상태: **설계 전용** (이번 6-AF에서는 구현하지 않음)
- 선행: 6-AE(read-only terminal snapshot) 완료, 6-AF(안전 재시작 검증) — 재시작은 활성 빌드로 **보류**

---

## 0. 문제 정의

현재 자동개발의 **실제 실행 경로**와 **대시보드 DB 모델**이 단절되어 있다.

```
실제 실행:  PM-tick(launchd) → orchestrator(PTY) → MCP delegate → /api/agents/:id/start → electron PTY (in-memory output buffer)
DB 모델:    dorothy.db  runs / run_steps / agent_sessions / plans / artifacts  = 전부 0건 (미사용)
```

결과: `/runs`·`/sessions`(DB 기준)가 비어 보임. 6-AE에서 PTY 스냅샷을 읽기 전용으로 비췄으나, **영속 기록(누가·언제·무엇)이 없어** 시계열/이력/Run 단위 추적이 불가.

**6-AG 목표:** PTY 실행 레이어의 관측 데이터를 dorothy.db에 **read-only로 미러**한다. 강제 dispatch·RunStep 생성·kill 없이 **"기록만" 추가**한다.

---

## 1. 설계 원칙 (안전 우선)

1. **관측 전용(observe-only)**: 미러는 실행을 *유발*하지 않는다. PTY가 이미 일어난 사실만 기록.
2. **기존 모델 비침습**: 기존 `runs`/`run_steps`(향후 정식 Run 기획)와 충돌 금지 → 미러 데이터는 `source='pty_mirror'`(Run) / `origin='pty_mirror'`(Session)로 **태깅 분리**.
3. **RunStep 강제 생성 없음**: 미러는 Run + AgentSession 수준까지만. RunStep은 만들지 않는다(6-AG 범위 밖).
4. **삭제/kill 없음**: upsert·status 갱신만. 종료 시에도 record는 `ended` 표시(물리 삭제 금지).
5. **idempotent upsert**: 동일 PTY 세션/틱은 중복 생성하지 않음(자연키 사용).
6. **마스킹 유지**: outputPreview/currentTask 등 텍스트는 6-AE `maskLine` 통과 후 저장.
7. **기준선 11만**: legacy UUID·codex+opus·ad-hoc은 미러 제외(`isSnapshotBaselineAgent`).
8. **장애 격리**: 미러 쓰기 실패가 PTY 실행/IPC/렌더를 절대 막지 않음(try/catch, best-effort).

---

## 2. 데이터 모델 (최소 변경)

기존 테이블을 재사용하되 미러 식별 컬럼만 추가한다(파괴적 마이그레이션 금지, `ALTER TABLE ADD COLUMN` + nullable).

### 2-1. Run (PmTickRun / SystemRun 미러)
- 기존 `runs` 재사용. `source` 값에 `'pty_mirror'` 추가(enum 확장).
- 자연키: `pmTickCycleId` = PM-tick STARTED 타임스탬프(예: `pty-2026-06-07T05:14:09+0900`).
- 한 PM-tick 사이클 = 1 Run(mirror). title 예: `PM-tick cycle 05:14 (orchestrator)`.
- `mode`(선택): `'mirror'` 추가 또는 기존 mode 미설정 유지. **권장: `source='pty_mirror'`만으로 구분**(mode는 건드리지 않음).

신규 컬럼(runs):
```sql
ALTER TABLE runs ADD COLUMN mirror_cycle_id TEXT;   -- nullable, pty_mirror 전용 자연키
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_mirror_cycle ON runs(mirror_cycle_id) WHERE mirror_cycle_id IS NOT NULL;
```

### 2-2. AgentSession (PTY 세션 미러)
- 기존 `agent_sessions` 재사용.
- 자연키: `ptyId`(electron 부여 uuid) — 세션당 1 row.
- 필드 매핑(AgentTerminalSnapshot → agent_sessions):
  | snapshot 필드 | agent_sessions 컬럼 | 비고 |
  |---|---|---|
  | agentId | agent_id | 기준선 11 |
  | ptyId | pty_id (신규, 자연키) | upsert 키 |
  | status | end_status / live_status | running/waiting→live, idle/completed→ended |
  | currentTask | current_task (신규, masked) | |
  | outputPreview | last_preview (신규, masked) | 최근 2줄 |
  | lastActivity | last_activity_at | |
  | (Run.mirror) | run_id | 해당 PM-tick Run에 연결 |

신규 컬럼(agent_sessions):
```sql
ALTER TABLE agent_sessions ADD COLUMN pty_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN origin TEXT;          -- 'pty_mirror'
ALTER TABLE agent_sessions ADD COLUMN current_task TEXT;    -- masked
ALTER TABLE agent_sessions ADD COLUMN last_preview TEXT;    -- masked
ALTER TABLE agent_sessions ADD COLUMN live_status TEXT;     -- running/waiting/idle/...
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_pty ON agent_sessions(pty_id) WHERE pty_id IS NOT NULL;
```

> 모든 신규 컬럼 nullable → 기존 코드/쿼리 무영향. 기존 정식 Run/Session 기획 시 `origin IS NULL`로 분리 조회 가능.

---

## 3. 미러 트리거 지점 (관측 후크)

기존 코드에 **부수효과 없는 best-effort write**만 삽입한다.

### 3-1. PM-tick start → Run mirror
- 위치: PM-tick STARTED를 기록하는 지점(현재 `pm-tick.log`에 STARTED 기록). 두 방식 중 택1:
  - (A) **로그 파서 미러러**(권장, 최소 침습): 별도 경량 워처가 `pm-tick.log`의 STARTED 라인을 파싱해 `runs(source='pty_mirror', mirror_cycle_id=…)` upsert. PM-tick 스크립트 자체는 미변경.
  - (B) PM-tick 스크립트가 `/api/runs/mirror` 호출. → 스크립트 수정 필요(보류, 6-AH 후보).
- 6-AG는 **(A)** 채택: PM-tick·launchd 무수정.

### 3-2. agent-manager startAgent → AgentSession mirror (생성)
- 위치: `electron/services/api-routes/agent-routes.ts`의 `POST /api/agents/:id/start` 성공 직후(ptyId 확보 시점) 또는 `agent-manager`의 PTY spawn(`ptyProcess` 생성, `agent-manager.ts:561` 부근).
- 동작: `isSnapshotBaselineAgent(id)`일 때만 `agent_sessions` upsert(pty_id 자연키, origin='pty_mirror', run_id=현재 mirror Run, started_at, live_status='running').
- best-effort: 미러 실패해도 start는 정상 진행.

### 3-3. PTY status 변경 → session status 갱신
- 위치: `agent-manager.ts`의 `ptyProcess.onExit`(`:588` 부근) + status emitter(`status:${agentId}`).
- 동작: onExit → 해당 pty_id 세션 `live_status='ended'`, `ended_at` 갱신(삭제 아님). status 변경 → `live_status` 갱신 + `last_activity_at`.

### 3-4. 주기적 스냅샷 동기화(선택, 저비용)
- 위치: 신규 경량 인터벌(예: 15s) in electron main. `buildBaselineSnapshots()` 결과로 각 세션의 `current_task`/`last_preview`/`live_status`/`last_activity_at`를 upsert.
- 장점: onData마다 쓰지 않고(과쓰기 방지) 15s 배치로 관측 상태 최신화. outputPreview는 이미 마스킹됨.
- 비용: 11 row upsert/15s = 무시 가능.

> **권장 구현 순서**: 3-4(주기 스냅샷 동기화) 단독으로도 `/sessions`·`/runs` 미러가 채워진다. 3-2/3-3은 정밀 이벤트(시작·종료 시각) 보강. 3-1(A)는 Run 묶음. → **3-4 먼저, 그다음 3-1(A), 마지막 3-2/3-3**.

---

## 4. 조회 경로 (렌더러)

- 신규 IPC/REST: `dorothy:sessions:list`에 `origin='pty_mirror'` 필터 옵션 추가(기존 핸들러 확장), 또는 `dorothy:runs:list`에 `source='pty_mirror'`.
- `/sessions`: 기존 6-AE Live 섹션(실시간 PTY) **유지** + 하단에 "기록된 PTY 세션(미러)" 표 추가(이력·시작/종료 시각).
- `/runs`: `source='pty_mirror'` Run이 생기면 "PM-tick Cycles(mirror)" 컬럼/섹션으로 표시. 6-AE의 "Run 미러 미연결" 안내는 **미러 활성 시 자동 숨김**(조건: `runs.filter(source==='pty_mirror').length>0`).

---

## 5. 작업 항목 (6-AG 구현 시)

| # | 항목 | 파일(예상) | 위험 |
|---|---|---|---|
| 1 | 마이그레이션: runs/agent_sessions nullable 컬럼 + 인덱스 | `electron/services/dorothy/migrations/*` | 낮음(ADD COLUMN) |
| 2 | mirror 서비스: upsertMirrorRun / upsertMirrorSession / endMirrorSession | `electron/services/dorothy/pty-mirror-service.ts`(신규) | 낮음 |
| 3 | 주기 스냅샷 동기화(15s) → 세션 upsert | `electron/core/agent-manager.ts` 또는 신규 타이머 | 낮음(best-effort) |
| 4 | startAgent/onExit 후크 연결 | `agent-routes.ts`, `agent-manager.ts` | 중(실행 경로 인접 → try/catch 필수) |
| 5 | PM-tick 로그 파서 → mirror Run upsert | 신규 워처 | 낮음(읽기 전용 로그) |
| 6 | sessions/runs 조회에 origin/source 필터 | `dorothy-runs-handler.ts`, 클라이언트/훅 | 낮음 |
| 7 | `/sessions` 미러 이력 표 + `/runs` mirror 섹션 + 안내 자동 숨김 | `SessionList`, `RunBoard` | 낮음 |
| 8 | 테스트: mirror 서비스 순수 매핑, idempotent upsert, baseline 필터, 마스킹 | `__tests__/` | 낮음 |

---

## 6. 명시적 비목표 (6-AG에서 하지 않음)

- RunStep 생성/기획(별도 Phase).
- 실행 제어(start/stop/kill/dispatch) — 미러는 관측 전용.
- 기존 0건 Run 모델의 의미 재정의(정식 Run 파이프라인은 별도).
- App Factory 연계.
- legacy UUID/codex+opus 미러.

---

## 7. 검증 기준 (6-AG 완료 시)

```text
- /sessions: 실시간 Live 섹션 + 미러 이력 표(시작/종료 시각, run 연결) 동시 표시
- /runs: source='pty_mirror' Run이 PM-tick 사이클별로 나타남, 미연결 안내 자동 숨김
- agent_sessions에 origin='pty_mirror' row가 PTY 시작/종료에 따라 생성/갱신(삭제 0)
- 미러 실패 주입 시에도 PTY 실행/IPC/렌더 무중단
- 마스킹: current_task/last_preview에 secret 미노출
- 기준선 11 외 미러 0건
- tsc 0(non-test), 기존 테스트 무회귀
```

---

## 8. 롤백 안전성

- 신규 컬럼은 nullable·미사용 시 무영향 → 기능 비활성화는 후크 제거 + 타이머 중지만으로 가능(스키마 유지 OK).
- 미러 데이터는 `origin='pty_mirror'`로 격리 → 필요 시 해당 row만 정리 가능(단, 6-AG는 삭제 안 함).
