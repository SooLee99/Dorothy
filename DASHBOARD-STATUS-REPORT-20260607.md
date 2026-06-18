# Dorothy 대시보드 / triplan 자동개발 — 종합 상태 보고서 (상세판)

- 작성: 2026-06-07
- 범위: Dorothy MVP 자율 에이전트 대시보드 + triplan 제품 자동개발
- 근거: 전부 실측 (git / launchctl / lsof / list_agents / dorothy.db / kanban-tasks.json / 로그 / .claude)

---

## 0. 한눈에 요약 (TL;DR)

| 영역 | 상태 | 핵심 수치 |
|---|---|---|
| 대시보드 health | ✅ 정상 | next :3500 UP, electron API :31415 UP, `OK` |
| 실행 인스턴스 | ✅ dev 단독 | stale release Dorothy.app 종료(혼선 해소) |
| 기준선 에이전트 | ✅ 정상 | 11개 (legacy UUID 0, codex+opus 0) |
| 라이브 세션 | 🟢 활발 | claude PTY **15개** 가동 |
| 자동실행(PM-tick→orchestrator) | ✅ 가동 | ~10분 주기, 최근 02:28 STARTED, backend running |
| half-state 자동복구 | ✅ 구현 | wrapper watchdog + check 분류 |
| Kanban | 258건 | done 135 / ongoing 3 / backlog 120 |
| Skills | 14개 | 자동개발 핵심 스킬 완비 |
| 최근 24h 산출 보고서 | 86건 | 자동개발 매우 활발 |
| 대시보드 터미널 UI | ⏸ 롤백 | 요구사항 `DASHBOARD-TERMINAL-REQUIREMENTS.md` |
| **이번 변경** | ✅ | **칸반 프로젝트별 필터 정규화 개선** |

---

## 1. 개발 상태 (Development State)

### 1-1. Dorothy 대시보드 레포 (`~/ai-company-stack/Dorothy`)
- 브랜치 `main` / HEAD `4482713 (chore: bump version to 1.2.8 #55)`
- 작업트리: 수정 42 · 미추적 85 (MVP 전 기능 대량 uncommitted = 정식 커밋/패키징 전 작업본)
- 빌드: `npx next build` ✅ 전 라우트 성공 / `tsc -p electron` 0 / `tsc(src)` 0
- 패키징 주의: `ELECTRON_BUILD=1`(정적 export)은 API 라우트 `/api/agents/[id]/stream`(SSE)와 비호환 → 정식은 `npm run electron:build`(빌드 전 `src/app/api` 임시 이동)

### 1-2. triplan 제품 레포 (자동개발 대상)
| 레포 | 브랜치 | HEAD | dirty | 의미 |
|---|---|---|---|---|
| triplan-frontend | feature/triplan-mvp | 46dde2f | 0 | 클린(커밋 반영됨) |
| triplan-travel-service | feature/triplan-mvp | 68ebf7f | 7 | 백엔드 에이전트 진행 중(QG-46 등) |
| soo-auth-service | feature/kakao-login-support | 1193864 | 0 | 클린 |

→ 자동개발이 **실코드/테스트/문서 산출 중**(travel-service dirty 7 + 최근 24h 보고서 86건이 증거). 커밋은 클린 분리 시에만, 보안/auth/push/production은 승인 게이트.

---

## 2. 에이전트 상태 (Agent State)

### 2-1. 기준선 11개 (agents.json, 전부 claude provider)
- **기본 프로세스 8**: intake-planner · architect-plan · orchestrator · plan-validator · contract-agent · database-agent · qa-reviewer · devops-reporter
- **개발·검증 보조 3**: backend · frontend · security-reviewer
- legacy UUID 0 / codex+opus 0 (6-T repoint + 정리 완료)

### 2-2. 라이브 상태 (list_agents 실측)
| 에이전트 | status | 현재 작업 |
|---|---|---|
| backend | 🟢 running | QG-46(ai-itinerary indoor-pool) 보고서/구현 (travel-service) |
| orchestrator | waiting | PM-tick 24h 사이클(team-orchestration) |
| qa-reviewer | waiting | 기능별 품질 감사(읽기전용 net-new 발굴) |
| frontend | waiting | FE-NAV-TEST-1 구현 |
| intake-planner / architect-plan / plan-validator / contract-agent / database-agent / devops-reporter | waiting | warm-up / standby |
| security-reviewer | idle | 대기 |

→ fleet 활발. 대부분 waiting(작업 보유/큐), backend 실제 실행.

---

## 3. 프로세스 상태 (Process State)

- **dev 대시보드**(launchd `com.dorothy.dashboard`): next dev :3500 + electron API :31415 — 둘 다 UP, health `OK next=up api=up health=ok`
- **release Dorothy.app**: 종료됨(6-AD). 현재 Dorothy 창은 dev 단독 → 사용자가 보는 창 혼선 해소
- **launchd 작업**(전부 정상 exit 0):
  - `com.triplan.pmtick` — PM-tick(자동개발 엔진, ~10분)
  - `com.dorothy.scheduler.2bc355b7` — 보조 스케줄러
  - `com.dorothy.dashboard` — 대시보드 wrapper(self-healing)
- **라이브 에이전트 프로세스**: claude PTY **15개**(MCP orchestrator가 `/api/agents/:id/start`로 electron PTY 스폰)
- **half-state 자동복구**: electron(:31415)만 죽고 next(:3500)만 사는 상태 → wrapper watchdog가 감지→dev스택 정리(release/MCP 불가침)→재시작. `check-dorothy-dashboard.sh`가 `OK/HALF_STATE/DOWN/DEGRADED` 분류
- **위생**: 최근 로그 `command not found` 0, codex+opus 신규 실행 0, 레거시 UUID(484bb96c) 호출 0
- **백업**: `~/.dorothy/*.bak.*` 19개(agents/db/kanban/scripts 안전 백업)

---

## 4. 스킬 상태 (Skill State)

### 4-1. 등록 스킬 14개 (`triplan/.claude/skills`)
| 스킬 | 역할 |
|---|---|
| team-orchestration | 위임/조율(프로세스 slug 기준) |
| backlog-discovery | TODO/FIXME/문서공백/에러 스캔으로 새 일 발굴 |
| agent-reporting | 산출물 보고서 형식 |
| backend-development / frontend-development | 구현 가이드 |
| qa-testing / security-review | 검증 |
| contract / docs-update / ops-runbook / cost-optimization | 계약·문서·운영·비용 |
| approval-gate / cooldown-resume / engine-routing / auto-company-loop | 게이트·재개·라우팅·루프 |

### 4-2. Skill Candidate(자기개선)
- dorothy.db `skill_candidates` 0건 — 현재 신규 후보 없음. ImprovementSignal 기반 생성만, **파일 자동생성/Evolution Agent 없음**(정책)

---

## 5. 세션 상태 (Session State)

- **라이브 PTY 세션**: 15개(agent-manager 소유, electron in-memory). 실제 에이전트 실행 = 이 PTY
- **dorothy.db `agent_sessions`**: 0건(미종료 0)
- ⚠️ **중요 구조적 사실**: 실제 fleet 실행 경로는 **PM-tick → orchestrator → MCP delegate → electron PTY**이며, dorothy.db의 Run-centric 모델(`runs`/`run_steps`/`agent_sessions`/`plans`/`artifacts` 전부 0건)은 **미사용**. 즉 세션은 PTY 버퍼에만 존재(영속 DB 기록 아님)
- 영향: `/sessions`·`/runs` 화면(dorothy.db 기준)이 비어 보임 — 실제 실행은 PTY로 진행됨. "두 오케스트레이션 레이어 공존"(MCP/PM-tick vs Run 모델)의 결과

---

## 6. 실행 가능한 워크플로우 상태 (Runnable Workflows)

### 6-1. 프로세스 파이프라인
```
intake-planner → architect-plan → (plan-validator 게이트)
   → contract-agent / database-agent → backend / frontend
   → qa-reviewer (+ security-reviewer) → devops-reporter
```
- team-orchestration 스킬 + pm-tick-prompt가 **프로세스 slug 기준** 위임(6-T 완료, 레거시 UUID 제거)
- PM-tick(~10분)이 orchestrator 기동 → 백로그 발굴/분배. **위임형**(전원 강제 실행 안 함, 사용자 결정)

### 6-2. 자동실행 cadence (pm-tick 최근 실측)
```
01:48 RESET→STARTED · 01:58 SKIP(처리중) · 02:08 RESET→STARTED
02:18 SKIP · 02:28 RESET→STARTED · 04:23 SKIP · 04:33 SKIP(처리중)
```
→ 약 10분 주기로 깨우되, 처리 중이면 SKIP(중복 방지), 멈추면 RESET 후 재시작. 정상 동작.

### 6-3. 에이전트 정의 파일(.claude/agents)
- 활성 11 slug 정의 + 레거시 정의(pm/qa/docs/approval-manager/cost-optimizer/ops.md) 파일 보존(미사용, 삭제 안 함)

### 6-4. App Factory(계획전용, 후순위)
- `app_candidates` 1건(공중화장실 편의시설 찾기 seed), `app_factory_plans` 0. Sidebar 하단 "나중". 실제 앱 생성 없음

---

## 7. 칸반 상태 (Kanban) — 상세

### 7-1. 전체
- **총 258건** = done **135** / ongoing **3** / backlog **120**

### 7-2. 프로젝트별 × 컬럼 (정규화 그룹)
| 프로젝트 | done | ongoing | backlog | 합 |
|---|---|---|---|---|
| triplan (코어) | 76 | 1 | 6 | 83 |
| triplan-travel-service (백엔드) | 29 | 1 | 3 | 33 |
| triplan-frontend (프론트) | 30 | 0 | 0 | 30 |
| soo-auth-service (인증) | 1 | 0 | 0 | 1 |
| Dorothy 개선(dorothy-improvements) | 0 | 0 | 83 | 83 |
| Dorothy 스킬후보(dorothy-skill-candidates) | 0 | 0 | 28 | 28 |

→ triplan 제품(코어/백엔드/프론트/인증)은 done 비중 높음(136 done). backlog 120 중 111건이 Dorothy 자체 개선/스킬후보(제품 아님).

### 7-3. 에이전트별 소유(전체 task)
- 미배정 201 · frontend 24 · backend 12 · LEGACY-UUID 13(과거 done 태스크의 historical owner) · ops 3 · security-reviewer 2 · devops-reporter 2 · qa-reviewer 1
- **active(ongoing) owner는 전부 프로세스 slug**(레거시 UUID는 done/historical에만 잔존) — 6-T 마이그레이션 정상

### 7-4. ✅ 이번 변경 — 프로젝트별 필터 개선
- `KanbanBoard`의 프로젝트 필터를 **정규화 그룹핑**으로 개선:
  - 경로인코딩 projectId(`-Users-soo-...`) 중복을 **clean 키로 통합**(projectPath basename 우선 → projectId fallback)
  - 한글 라벨 + **task 카운트** 표시: `triplan (코어) · 83`, `triplan-travel-service (백엔드) · 33`, `triplan-frontend (프론트) · 30`, `Dorothy 개선 · 83`, `Dorothy 스킬후보 · 28`, `soo-auth-service (인증) · 1`
  - `/kanban` 상단 **프로젝트 드롭다운(FolderOpen)**에서 선택 → 해당 프로젝트만 칸반 표시(컬럼/검색/회사 필터와 조합)
  - undefined projectPath 가드 추가(크래시 방지)
- 변경 파일: `src/components/KanbanBoard/index.tsx` (모듈 헬퍼 `projectGroupKey`/`projectGroupLabel` + filteredTasks/projects 적용)
- 검증: tsc 0, `/kanban` 200

---

## 8. 자기개선/품질 신호 (Self-Improvement)

- `diagnostics` 1건: [low/open] Rate limit detected (claude)
- `improvement_signals` 2건: [medium/open] Rate-limited session remained in dry-run (×2)
- → 현재 신호는 rate-limit 계열 경미 수준. 자동 코드수정/Evolution Agent 없음(정책 유지)

---

## 9. 알려진 이슈 / 남은 위험

1. **대시보드 에이전트 터미널 UI 롤백됨** — 6-S~6-AG 구현했으나 사용자 화면에서 안 보여(dev/release 창 혼선 의심) 롤백. 재시도 가이드/요구사항: `DASHBOARD-TERMINAL-REQUIREMENTS.md`. 신규 컴포넌트는 디스크 보존(미마운트)
2. **dorothy.db Run 모델 미사용(전부 0건)** — 실제 실행은 PTY/MCP 경로 → `/sessions`·`/runs`가 비어 보이는 근본 원인. 두 레이어 통합 미해결
3. **Dorothy 레포 대량 uncommitted**(수정42/미추적85) — 정식 커밋/패키징 전 작업본
4. **half-state 주기적 재발 가능** — watchdog 자동복구하나 electron main 크래시 근본원인 미규명
5. **rate-limit 신호 누적** — 자동개발 사용량 한도 영향(cooldown-resume로 대기)

---

## 10. 다음 권장 작업

1. 대시보드 터미널 UI 재시도 전 **사용자가 보는 창 스크린샷**으로 dev/release 확정(요구사항 MD 기준)
2. (선택) Run 모델 ↔ PTY 실행 레이어 통합 → `/sessions`·`/runs`가 실제 실행 반영
3. half-state 근본원인(electron main 크래시) 조사
4. triplan 진행 작업(QG-46 등) 클린 분리 커밋 검토(보안/push 게이트 준수)
5. Dorothy 개선 backlog 83 + 스킬후보 28 트리아지(제품과 분리해 우선순위화)

---

### 부록 A. 데이터 출처
git(Dorothy/frontend/travel/auth), `launchctl list`, `lsof :3500/:31415`, `check-dorothy-dashboard.sh`, `mcp__claude-mgr-orchestrator__list_agents`, `~/.dorothy/agents.json`, `~/.dorothy/kanban-tasks.json`(258건), `dorothy.db`(better-sqlite3 readonly), `~/.dorothy/logs/pm-tick.log`, `triplan/.claude/{skills,agents,reports}`.

### 부록 B. 관련 문서
- `DASHBOARD-TERMINAL-REQUIREMENTS.md` — 롤백된 대시보드 터미널 보드 요구사항/재시도 가이드
- 본 문서 `DASHBOARD-STATUS-REPORT-20260607.md` — 종합 상태(상세)
