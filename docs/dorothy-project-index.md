# Dorothy — 프로젝트 인덱스 / 현황 README

> 다시 이 프로젝트를 열거나 인수인계할 때 ★여기부터 읽는다. 척추: **주장 아니라 실측 · 적게, 백엔드부터 · 게이트 통과 시에만.**

---

## ★실측 검증 (2026-06-10, 현재 환경 = `/Users/soo/ai-company-stack/Dorothy`)
```text
- §1 라이브 ✅: /api/dorothy/{sessions,providers,tasks,projects} 전부 200(next :3500).
- §7 git ✅: branch feature/dorothy-observability-phase0-2, 로컬 3커밋(c9c3904·052f413·272890e), upstream 없음(push 안 됨).
- §4 부채 ✅: 101 테스트타입(tsconfig.test.json 격리), Slack 발송 0(slackChannelId 미설정 no-op), 0c 그림자 로그 누적 시작(pm-tick 매 틱).
- ★§5 문서 카탈로그 정정: 아래 나열된 빌드 프롬프트/사양 .md 대부분은 ★현재 환경(Dorothy/docs/)에 미실존이다
  (이전 세션 /mnt/user-data/outputs 산출물 — 이 환경엔 없음). ★코드/라이브/git/부채는 현재 환경에 실존·검증됨.
  문서가 필요하면 이전 세션 산출물에서 가져와 docs/ 에 반영해야 한다. (현재 docs/ 실파일은 §5 와 다름.)
```

---

## 0. 한눈에 — 지금 상태
```text
✅ 라이브(구현·검증):  Phase 0(0-common·0a·0b·0c) · Phase 2 UI(U0~U3) · #2 통합빌드 복구 · Slack(A) 아웃바운드
⏳ 관측·게이트 대기:   0c 7일 그림자 관측 · §0.7 사용자 클릭 검수 · G0-3 수요(≥2주 실사용) · Slack 채널 설정/발송 확인
📋 사양만(미구현):     Part F/H 백엔드 자율화 · I/J/K/L/M 백엔드 신호 · Phase 1(건너뜀) · Phase 3(게이트) · Slack(B) 양방향
⚠️ 부채:              101 테스트타입(격리) · 풀빌드 1회만 실증 · git 로컬(push 안 함) · secret app-settings 평문(vault 아님)
                      · agentId /output 키 PTY 재생성 · onData 통합 hot-path 미측정 · Slack 실제 발송 0건(미확인)
                      · provider 한도의 '실제 dispatch 게이트 지점' 미확정
```

---

## 1. ✅ 구현 현황 (라이브 — Dorothy 레포 `feature/dorothy-observability-phase0-2`)
| 영역 | 무엇 | 상태 |
|---|---|---|
| **Phase 0 · 0-common** | 엔벌로프·observed 래퍼·serverNow(단조)·secret 마스킹(패턴, 값매칭 비활성) | ✅ |
| **Phase 0 · 0a** | `/api/dorothy/sessions`·`/sessions/{id}/output` — lastOutputAt·byteCount·outputActivity(recent\|silent)·ptyAlive, read-only·마스킹·tail-only(cursor 미구현), taskId observed:false. 마감(메모리 cap·임계테스트·hot-path 벤치·풀빌드) 완료 | ✅ |
| **Phase 0 · 0b** | `/api/dorothy/providers` — predicted vs ★프로브 확인(실제 호출 결과 재사용), available은 실측 ok만. dispatcher 미변경 | ✅ |
| **Phase 0 · 0c** | 그림자 모드(비교·기록만, ★dispatch 불변) — pm-tick 관측, probe-shadow-log + 집계(matchRate/falseOk/wouldDiffer) | ✅ 코드·관측 시작 (전환 아님) |
| **Phase 2 UI** | 기존 대시보드에 additive — ProjectsStrip(카드 클릭 필터)·작업 상세 탭([진행] picker+ReadonlyTerminal, [설계]/[산출물]+done 배지) | ✅ U0~U3 |
| **#2 통합빌드** | 프로덕션 tsc 0 + 풀 next build exit 0(1회 실증) | ✅ 복구 |
| **Slack(A)** | 아웃바운드 알림 — 실측 신호(silent·프로브 한도·escalation·pause)·폭주 방지·기존 `/api/slack/send` 재사용 | ✅ (채널 미설정=no-op, ★실제 발송 0건) |

**핵심 불변(라이브에서 지켜짐):** done 초록=verified만(주장 done 0) · FE/BE "응답함"=프로브 성공만 · running류 필드 부재 · 모르면 '확인 불가'.

**코드 위치:** `electron/core/observability/*`(server-clock·observed·envelope·secret-mask·session-metrics·provider-signal·task-signal·probe-shadow·slack-alert) · `electron/services/api-routes/{sessions,providers,tasks,projects}-routes.ts` · `src/components/phase2/*` · `src/app/api/dorothy/{sessions,providers,tasks,projects}/*` · `~/.dorothy/scripts/{probe-shadow-tick,probe-shadow-report,slack-alert-tick}.js` · pm-tick 관측 영역.

---

## 2. ⏳ 관측 · 게이트 대기 (코드 아님 — 시간/사용자)
```text
- 0c 7일 그림자: ≥7일 OR ≥500 의미있는 비교 · 일치율 ≥99% · false-ok 0 → 통과 시 카나리(별 PR). probe-shadow-report.js 로 집계.
- §0.7 사용자 클릭 검수(4건): ① 카드 클릭→필터+합성+해제 ② 작업→[진행]→picker→터미널 ③ 모달 편집/저장/삭제 ④ [설계]/[산출물] 빈 상태·done 배지.
- G0-3 수요: Phase 1~2 를 ≥2주 실사용 후 'Phase 3 기능이 실제로 필요'한지 데이터로. (없으면 Phase 3 미시작)
- Slack 활성화: Settings/SlackSection 에서 slackChannelId 설정 → ★실제 발송 1건 + dedupe/해제 1회 확인(현재 미확인).
```

---

## 3. 📋 사양만 (미구현 — 빌드 안 됨)
```text
- 백엔드 자율화: Part F(무인 하드닝)·Part H(운영·마스터) — 사양. (0a/0b/0c 가 그 중 신호 일부만 구현)
- 백엔드 신호: Part I(다중프로젝트·역할·세션 — 대시보드 일부만)·J(스캐폴드 Analyzer)·K(격리)·L(완료/졸업)·M(용량/WIP)
  → ★이들 백엔드 신호 미구현 → Phase 3 패널 만들면 빈 패널.
- Phase 1(관제실+세션 셸): ★건너뜀(Phase 2 가 기존 대시보드에 단독으로 얹힘).
- Phase 3(프리뷰·API·지식·격리/용량/완료 패널): ★게이트 미통과 — 미시작.
- Slack(B) 양방향(승인/일시정지): 골격만 — 인증·서명(verifyGithubSignature 재사용 가능)·section-0·감사·executor 분리로 게이트 후 별 PR.
- Part N(배포/CI 등): 사양 — 확인 권장(이 세션 범위 밖).
```

---

## 4. ⚠️ 부채 (추적 — 닫을 것)
```text
1. 101 테스트타입 에러 = '격리'(tsconfig.test.json)지 '해소' 아님 → 점진 수정 대상.
2. 풀 next build 는 ★1회만 실증 — CI 상시화 안 됨.
3. git 3커밋(c9c3904·052f413·272890e) ★로컬, push 안 함 → 백업/협업 위해 push 결정.
4. secret = app-settings ★평문(vault 아님) → Slack 토큰 포함 전체 secret vault 이전 부채.
5. /output 조회키 = agentId → PTY 재생성 시 잔상 가능(seq 최신으로 완화했으나 관측 필요).
6. onData ★통합 hot-path(<1%)는 미측정(per-call ~8.9µs 만) — statusLine/broadcast 지배(기존 코드).
7. Slack ★실제 발송 0건 — 채널 설정 후 도착·dedupe 확인 필요.
8. ★provider 한도가 '실제 dispatch 결정'에 영향 주는 지점 미확정(advanceRun 은 run.state 만) → 0c 카나리 전제.
```

---

## 5. 문서 카탈로그 (★현재 환경 Dorothy/docs/ 에는 대부분 미실존 — 이전 세션 산출물)
```text
※ 아래는 이전 세션(/mnt/user-data/outputs)에서 작성된 빌드 프롬프트/사양 목록이다. 현재 환경 docs/ 에는 없음(코드만 반영).
   재개 시 문서가 필요하면 이전 세션 산출물에서 가져와 docs/ 에 반영할 것.

A. 정본 빌드 프롬프트: Phased-Requirements · Phase0-Backend-Signals-v3 · 0a-Closeout · 0c-Shadow · Phase2-v2 · Phase2-U0~U3 ·
   Phase3-Advanced · Phase3-Entry-Gate-Evaluation · Slack-Integration
B. 대시보드 디자인/목업: Dashboard-Redesign-Guide · Refactor-Prompt · Signals-API · MissionControl-Mockup.html · Sessions-Terminal-Grid.html
C. 시스템 설계 사양(Part 시리즈, 대부분 사양): PartF/H/I/J/K/L/M/N · Agent-Workflow-Process · Implementation-Checklist
D. 이전/보조본(정본과 대조 후 사용): Dashboard-Prompt-00~10 · Slice1/2 · v1/v2(superseded)
```

---

## 6. 재개 시 읽는 순서
```text
1. 이 README(§0~4) — 현황·부채.
2. 라이브 코드: electron/core/observability/* · src/components/phase2/* · probe-shadow* · slack-alert* · pm-tick 관측 영역.
3. 메모리: ~/.claude/projects/-Users-soo-workspace-source-code-triplan/memory/dorothy-phase0-observability.md (상세 이력).
4. 대기 게이트: 0c 7일(probe-shadow-report.js) · §0.7 검수 · G0-3 수요.
5. 다음 코드 후보: provider-한도 실제 게이트 지점 recon → 0c 카나리 / Slack 채널 설정·발송 확인 / 부채(§4) 정리.
```

---

## 7. git / 커밋·푸시 상태
```text
- Dorothy 레포: feature/dorothy-observability-phase0-2 — 로컬 커밋 3개(c9c3904·052f413·272890e). ★push 안 됨.
- 빌드 규율: PR 끝마다 로컬 커밋(클린 분리, 내 파일만) / push 는 수동(명시 지시 필요).
- 권장: (a) 로컬 3커밋 push 여부 결정 · (b) §5 정본 문서를 이전 세션에서 가져와 docs/ 반영할지 결정.
```

---

## 한 줄 요약
```text
라이브 = Phase 0(0-common/0a/0b/0c)·Phase 2 UI(U0~U3)·#2 빌드복구·Slack(A, no-op). 전부 '실측·비파괴·done은 verified만'.
대기 = 0c 7일·§0.7 검수·G0-3 수요·Slack 발송확인. 미구현 = Part F/H·I/J/K/L/M·Phase1(건너뜀)·Phase3(게이트)·Slack(B).
부채 = 101테스트타입(격리)·풀빌드1회·git 로컬·secret 평문·agentId 키·통합벤치·Slack 발송0·provider 게이트지점 미확정.
다음은 코드보다 ★닫기: §0.7 검수 + Slack 발송확인(브라우저/설정 1회) → push 결정 → provider 게이트 recon → 0c 카나리.
```
