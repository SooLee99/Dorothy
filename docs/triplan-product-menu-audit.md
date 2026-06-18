# triplan 제품(앱) 메뉴 감사 — 구현/연동 현황

> 작성: 2026-06-07 / 범위: triplan-frontend 27개 라우트(화면) · 백엔드 API 연동 · 라이브 엔드포인트(:8080)
> 방식: 코드 감사(스텁/TODO/연동) + API 호출 추적 + 라이브 엔드포인트 응답. ※ 실제 UI 클릭은 헤드리스 불가 → 코드/계약 레벨.

## 요약
- 화면 27개 전부 컴포넌트 + 단위테스트(`*.test.tsx`) 존재 (스텁/빈화면 거의 없음)
- 백엔드 API 연동: 추천·인증·장소·여행(CRUD) 모두 연결됨
- 라이브 엔드포인트(:8080): 전부 응답 — health 200 / ai-itinerary 400(=유효, 바디필요) / places/search 400(=유효) / trips 401(=인증필요)
- ⚠️ **실 미구현/미연동 3건** (아래)

## 화면별 연동 현황
| 화면(route) | 백엔드 연동 | 상태 |
|---|---|---|
| `/home` TripInfo | (context store) | ✅ |
| `/style` Style, `/mode` Mode, `/departure` DepartureArrival | recommendations | ✅ |
| `/places` Places, `/place-search`, `/place-detail`, `/map-search`, `/destination` | places, recommendations | ✅ |
| `/ai-itinerary` AiItinerary | recommendations(ai-itinerary) | ✅ (LLM 불가 시 "AI 준비 중" 폴백 — 정상 graceful) |
| `/saved` SavedTrips, `/history` TravelHistory, `/editor` Timeline, `/calendar` | trips(읽기+쓰기) via context | ✅ (getTrips + create/update/delete/reorder + 인증 시 remote 병합) |
| `/share` Share | (로컬/공유) | ✅ |
| `/login`, `/auth/kakao` Kakao | auth | ✅ |
| `/mypage` MyPage | auth | ✅ |
| `/notifications`, `/privacy`, `/onboarding`, `/splash` | 순수 UI | ✅ |
| `/support` CustomerSupport | (FAQ 정적) | ⚠️ 1:1 채팅 준비중 |

## 백엔드 API 연동(실측)
- `getTrips`(읽기) 1회 + `createTrip`/`updateTrip`×2/`deleteTrip`/`reorderTripPlaces` 호출됨 → **여행 CRUD write-back 연동 확인** (context.tsx). 인증 시 remote 병합(FE-TRIP-SYNC-HYDRATE).
- recommendations(ai-itinerary/장소추천), places(검색/상세), auth(카카오) 연동 확인.

## ⚠️ 발견된 미구현 / 미연동

1. **1:1 채팅 — 준비중(미구현)** (`CustomerSupportScreen`): 백엔드 미지원으로 명시적 `disabled`+"준비중". → 백엔드 채팅 기능 필요(또는 의도적 보류).
2. **이용약관 페이지 없음** (`/terms` 라우트 0): LoginScreen의 "이용약관" 링크가 라우트/문서 부재로 `disabled`("준비중"). → `/terms` 화면(또는 외부 문서 링크) 추가 필요.
3. **⚠️ 라이브 미반영(done≠live)**: 추천(여행 스타일/끼니) 등 코드는 backend(`recommendation/ai/*`)·frontend(`AiItineraryScreen`) 양쪽 구현됐으나 **backend 코드 미커밋 + 라이브 서버가 코드 변경 전 기동(stale)** → **실제 서비스엔 미동작**. (done≠live 게이트가 79건 플래그) → 커밋 + 서버 재기동 필요.

## 결론
- **제품 화면/연동 자체는 대체로 완성**(27화면·CRUD·추천·인증·장소 연동, 단위테스트 보유).
- 실 미구현은 **1:1 채팅·이용약관 페이지** 2건 + **라이브 배포 갭(done≠live)** 1건.
- "메뉴를 눌렀는데 안 됨"의 주원인은 미구현이 아니라 **라이브 서버 미반영(커밋·재기동 안 됨)** 일 가능성이 큼.

## 다음 권장
1. (최우선) **done≠live 해소** — 완료 작업 커밋 + 서버 재기동(사용자 승인 사항)으로 라이브 반영.
2. `/terms` 이용약관 화면 추가.
3. 1:1 채팅: 백엔드 지원 추가 또는 정식 "추후 지원" 표기.
