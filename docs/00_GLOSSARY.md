# 용어

이 저장소의 문서 전체에서 쓰는 용어다. 처음 읽을 때 옆에 두고 본다. "상세" 열은 그 용어를 자세히 다루는 절이다.

- 상태 이름(OPEN, PENDING 등)은 DB에 숫자 코드로 저장된다. 이름과 숫자의 짝은 `src/core/codes.ts`와 컬럼 COMMENT에 있다([D-46](02_DECISIONS.md#d-46)).
- 회귀 테스트 항목 번호(S0, C1 등)는 [08_TEST_CASES](08_TEST_CASES.md)에 있다.

## 기본

| 용어 | 뜻 | 상세 |
| --- | --- | --- |
| D-xx | `02_DECISIONS.md`의 결정 번호. 왜 그렇게 정했는지가 거기 있다 | — |
| 싱글테넌트 (DE) | 게임 프로젝트 하나에 서버·DB를 따로 설치하는 방식. 여러 게임이 한 DB를 나눠 쓰지 않는다. 그 하나를 "설치본"이라 부른다 | [01_DESIGN 1.2](01_DESIGN.md#s-1-2) |
| 원장 | 기록의 최종 기준. 이 시스템에서는 MySQL이다. 다른 곳과 값이 다르면 MySQL이 맞다 | [01_DESIGN 1.5](01_DESIGN.md#s-1-5) |
| 투영 | 원장에서 계산해 만든 복사본. Redis 순위표는 MySQL 행으로 언제든 다시 만들 수 있다 | [01_DESIGN 1.5](01_DESIGN.md#s-1-5) |
| 게임 서버 | 이 랭킹 서버를 부르는 쪽. 점수를 제출하고, 순위를 조회하고, 보상 목록을 가져가 실제로 지급한다 | [01_DESIGN 10.2](01_DESIGN.md#s-10-2) |
| GM | Game Master, 게임 운영자. 제재 등록, 검수 보류 같은 사람의 조작을 한다 | [01_DESIGN 7.5](01_DESIGN.md#s-7-5) |
| 결과 코드 (`result`) | 모든 응답에 있는 정수. 0은 성공, 그 밖은 실패 이유다(예: 1101 랭킹 없음, 50001 DB 오류) | [01_DESIGN 10.3](01_DESIGN.md#s-10-3) |
| SP | Stored Procedure. MySQL 안에 저장해 두고 호출하는 프로시저. 이 시스템의 DB 로직은 모두 SP에 있다 | [01_DESIGN 1.3](01_DESIGN.md#s-1-3) |
| S2S | Server to Server, 서버 간 호출. 여기서는 게임 서버가 API를 부르는 경로다 | [01_DESIGN 10.2](01_DESIGN.md#s-10-2) |

## 랭킹과 점수

| 용어 | 뜻 | 상세 |
| --- | --- | --- |
| 랭킹 (랭킹 정의) | 순위 하나를 정하는 규칙 묶음. 갱신 규칙, 정렬 방향, 점수 범위, 시즌 주기, 보상 구간을 가진다(`ranking_definition`) | [01_DESIGN 2.1](01_DESIGN.md#s-2-1) |
| 멤버 (`member_id`) | 게임 서버가 넘기는 플레이어 ID. 대소문자를 구분한다 | [01_DESIGN 4.2](01_DESIGN.md#s-4-2) |
| 갱신 규칙 (BEST / SUM) | 같은 멤버가 다시 제출했을 때 점수를 정하는 방법. BEST는 더 좋은 기록만 남기고, SUM은 더한다 | [01_DESIGN 2.3](01_DESIGN.md#s-2-3) |
| 멱등 키 (`requestId`) | 게임 서버가 제출마다 새로 만드는 고유 ID. 같은 ID로 다시 보내면(재전송) 두 번 반영하지 않는다. 같은 ID에 다른 내용이면 거부한다(1104) | [01_DESIGN 4.4](01_DESIGN.md#s-4-4) |
| 하드 검증 / 소프트 탐지 | 하드: 받지 않고 거부한다(점수 범위 등). 소프트: 받되 의심 근거만 쌓는다(급등 등) | [01_DESIGN 9.1](01_DESIGN.md#s-9-1), [9.2](01_DESIGN.md#s-9-2) |
| 어뷰징 포인트 | 소프트 탐지 근거의 가중치 합. 검수 목록의 정렬 기준이다 | [01_DESIGN 9.3](01_DESIGN.md#s-9-3) |
| composite score | 점수와 달성 시각을 정수 하나로 합친 값. Redis 정렬만으로 "같은 점수면 먼저 달성한 쪽이 위"가 된다 | [01_DESIGN 5.2](01_DESIGN.md#s-5-2) |
| 비트 예산 | composite가 정확하려면 53비트(double의 정수 정밀도) 안에 들어가야 한다. 점수 비트 + 시간 비트 ≤ 53을 등록 시 검사한다 | [01_DESIGN 2.4](01_DESIGN.md#s-2-4) |
| 시간 슬롯 | 달성 시각을 `time_unit`(초, 분 등)으로 내림한 값. 같은 점수·같은 슬롯이면 `member_id` 순이다 | [01_DESIGN 5.2](01_DESIGN.md#s-5-2) |
| 랭킹 유형 (시즌 / 이벤트 / 영구) | `cycle_type`과 `end_at`으로 나뉜다. 시즌 랭킹은 주기 반복, 이벤트 랭킹은 시즌 하나(단일 시즌), 영구 랭킹은 끝이 없고 정산도 없다 | [01_DESIGN 2.5](01_DESIGN.md#s-2-5) |
| 벽시계 | 그 시간대의 달력·시계 기준 시각. 서머타임(DST)으로 하루가 25시간이 되는 날도 자정에서 끊으려고 쓴다 | [01_DESIGN 3.3](01_DESIGN.md#s-3-3) |

## 시즌과 정산

| 용어 | 뜻 | 상세 |
| --- | --- | --- |
| 시즌 (`season_no`) | 랭킹의 기간 단위. 번호는 1부터다. 제재에서 `season_no = 0`은 "그 랭킹의 전 시즌"을 뜻한다 | [01_DESIGN 3.1](01_DESIGN.md#s-3-1) |
| 시즌 상태 | SCHEDULED(예정) → OPEN(제출 받음) → CLOSED(마감) → SETTLING(가순위) → REVIEW(검수) → FINALIZING(확정) → DELIVERING(보상 전달) → SETTLED(끝) | [01_DESIGN 3.5](01_DESIGN.md#s-3-5) |
| 스케줄러 | 워커 안에서 시즌을 미리 만들고(진행 중 + 예정 3개 유지) 시각에 맞춰 OPEN·CLOSED로 넘기는 잡 | [01_DESIGN 3.3](01_DESIGN.md#s-3-3) |
| 정산 | 마감한 시즌의 순위를 매기고 보상을 정해 게임 서버에 넘기기까지의 과정. SETTLING부터 SETTLED까지다 | [01_DESIGN 7장](01_DESIGN.md#s-7) |
| 가순위 | 시즌 마감 후 제재를 반영하기 전에 매기는 임시 순위. 검수 뒤 확정한다 | [01_DESIGN 7.3](01_DESIGN.md#s-7-3) |
| 작업 테이블 (`ranking_entry_settling`) | 가순위를 매기는 동안 시즌 데이터를 잠시 옮겨 두는 빈 테이블. 정렬 인덱스를 여기에만 만들어 운영 테이블을 건드리지 않는다 | [01_DESIGN 7.3](01_DESIGN.md#s-7-3) |
| 검수 (`review_until`) | 순위 확정 전에 GM이 어뷰징을 확인하는 기간(`review_period`). `review_until`이 그 끝 시각이다 | [01_DESIGN 7.5](01_DESIGN.md#s-7-5) |
| 검수 보류 (`review_hold`) | GM이 확정을 미루는 표시. 풀 때까지 검수 기간이 지나도 확정하지 않는다 | [01_DESIGN 7.5](01_DESIGN.md#s-7-5) |
| 확정 | 제재 대상을 빼고 순위를 다시 매긴 뒤 보상을 정하는 단계(FINALIZING). 이후 순위는 바뀌지 않는다 | [01_DESIGN 7.6](01_DESIGN.md#s-7-6) |
| 보상 구간 (RANK / PERCENT) | 보상을 받는 순위 범위와 `reward_code`. RANK는 순위(1\~3위), PERCENT는 참가자 대비 비율(상위 10%)이다. 겹치면 RANK가 먼저다 | [01_DESIGN 2.6](01_DESIGN.md#s-2-6) |
| `reward_code` | 보상 구간에 붙은 코드. 이 서버는 코드만 정하고, 무엇을 줄지는 게임 서버가 해석한다 | [01_DESIGN 2.6](01_DESIGN.md#s-2-6) |
| 보상 상태 (`reward_status`) | NONE(대상 아님) / PENDING(전달 전) / DELIVERED(게임 서버가 지급 완료를 알림) / REJECTED(제재로 지급 안 함) | [01_DESIGN 7.4](01_DESIGN.md#s-7-4) |
| ack | 게임 서버가 "이 보상을 지급했다"고 알리는 호출. 받은 행은 DELIVERED가 된다 | [01_DESIGN 7.7](01_DESIGN.md#s-7-7) |
| Top N (`ranking_season_top`) | 확정 때 시즌 상위 `top_size`명을 따로 복사해 영구 보관하는 테이블. 시즌 데이터를 백업으로 분리한 뒤에도 조회할 수 있다 | [01_DESIGN 8.4](01_DESIGN.md#s-8-4) |

## 제재

| 용어 | 뜻 | 상세 |
| --- | --- | --- |
| 제재 (`ranking_exclusion`) | GM이 멤버를 순위에서 빼는 것. 시즌 하나 또는 전 시즌(`season_no = 0`)에 건다. 원장 기록은 그대로 둔다 | [01_DESIGN 7.8](01_DESIGN.md#s-7-8) |
| 제외 집합 (`:excl`) | 제재 멤버를 담은 Redis SET. 반영 Lua가 확인해 제재 멤버의 재제출이 순위표에 오르지 않게 한다 | [01_DESIGN 5.1](01_DESIGN.md#s-5-1), [7.8](01_DESIGN.md#s-7-8) |
| `sanctioned` | 검수가 끝난 뒤 등록된 제재의 표시. 순위와 보상은 그대로 두고 표시만 붙인다. 회수는 게임 서버가 정한다 | [01_DESIGN 7.4](01_DESIGN.md#s-7-4), [7.8](01_DESIGN.md#s-7-8) |

## 저장 구조 (MySQL)

| 용어 | 뜻 | 상세 |
| --- | --- | --- |
| 운영 테이블 | 서비스 중 계속 읽고 쓰는 테이블(`ranking_entry`, `ranking_submit_key`). 여러 랭킹이 함께 쓰므로 무거운 작업을 하지 않는다 | [01_DESIGN 1.5](01_DESIGN.md#s-1-5) |
| 시즌 파티션 | 운영 테이블을 (랭킹, 시즌) 단위로 나눈 물리 조각. 시즌 데이터를 통째로 옮기는 단위다 | [01_DESIGN 4.2](01_DESIGN.md#s-4-2) |
| EXCHANGE | `ALTER TABLE ... EXCHANGE PARTITION`. 파티션 하나와 일반 테이블의 데이터 파일을 행 복사 없이 맞바꾼다 | [01_DESIGN 8.1](01_DESIGN.md#s-8-1) |
| 백업 테이블 | EXCHANGE로 떼어 낸 시즌 데이터를 담은 일반 테이블 `{원본}_r{id}_s{n}` | [01_DESIGN 8.2](01_DESIGN.md#s-8-2) |
| 로그 DB (`podium_de_log`) | 제출 이력·감사 로그를 두는 별도 DB. 기록에 실패해도 본 처리는 성공한다 | [01_DESIGN 4.5](01_DESIGN.md#s-4-5) |
| 일 파티션 / 월 테이블 / `p_max` | 로그 DB의 보관 구조. 이력은 날짜별 파티션에 쌓이고, 보관 기간이 지나면 월 테이블로 옮겨진다. `p_max`는 미리 만든 날짜 밖의 행을 받는 안전망이며, 행이 생기면 경고한다 | [01_DESIGN 4.5](01_DESIGN.md#s-4-5) |
| 메타데이터 수준 | 행 데이터를 건드리지 않고 테이블 정의만 바꾸는 작업. 크기와 무관하게 바로 끝나지만, 그동안 MDL이 잠깐 걸린다 | [01_DESIGN 8.1](01_DESIGN.md#s-8-1) |
| MDL | Metadata Lock. DDL(테이블 구조 변경)이 잡는 MySQL 잠금. DDL이 MDL을 기다리는 동안 그 테이블의 다른 쿼리도 뒤에서 막힌다 | [01_DESIGN 11.1](01_DESIGN.md#s-11-1) |
| INSTANT | `ALGORITHM=INSTANT`. 데이터를 다시 쓰지 않고 테이블 정의만 바꾸는 DDL 방식이라 즉시 끝난다 | [01_DESIGN 11.1](01_DESIGN.md#s-11-1) |
| backfill | 컬럼 추가 등의 뒤에 기존 행 값을 한꺼번에 채우는 대량 UPDATE | [01_DESIGN 11.1](01_DESIGN.md#s-11-1) |
| ODKU | `INSERT ... ON DUPLICATE KEY UPDATE`. 행이 없으면 넣고 있으면 갱신하는 MySQL 구문(upsert) | [01_DESIGN 4.3](01_DESIGN.md#s-4-3) |
| DDL | 테이블 구조를 바꾸는 SQL(`CREATE`, `ALTER`, `DROP`) | [01_DESIGN 11.1](01_DESIGN.md#s-11-1) |
| entry / submit_key / settling | `ranking_entry` / `ranking_submit_key` / `ranking_entry_settling`의 줄임 | [04_SCHEMA](04_SCHEMA.md) |
| 앱 계정 / migrate 계정 | 앱 계정은 SP 실행 권한(`EXECUTE`)만 있고, migrate 계정은 테이블·SP를 만들고 바꾼다 | [D-44](02_DECISIONS.md#d-44) |
| DEFINER / INVOKER | SP를 누구 권한으로 실행할지 정하는 설정. DEFINER는 만든 계정, INVOKER는 호출한 계정의 권한이다 | [D-51](02_DECISIONS.md#d-51) |

## Redis와 자가 복구

| 용어 | 뜻 | 상세 |
| --- | --- | --- |
| 순위표 | 시즌마다 하나인 Redis ZSET. 실시간 순위 조회는 여기서 읽는다 | [01_DESIGN 5.1](01_DESIGN.md#s-5-1) |
| 반영 Lua | 제출 결과를 순위표에 쓰는 Redis 스크립트. 센티넬과 제외 집합을 확인한 뒤에만 쓴다 | [01_DESIGN 5.3](01_DESIGN.md#s-5-3) |
| 센티넬 (`:ready`) | Redis에 "이 시즌 순위표에 써도 된다"고 표시하는 키. 없으면 반영은 버리고 조회는 2007로 응답한다. 값은 Redis가 따라잡은 DB 시각 T(ms)다 | [01_DESIGN 5.3](01_DESIGN.md#s-5-3), [6.2](01_DESIGN.md#s-6-2) |
| 자가 복구 L1·L2·L3 | Redis가 MySQL과 어긋났을 때 맞추는 3단계. L1 즉시 재시도, L2 리컨실러, L3 전체 재구축 | [01_DESIGN 6장](01_DESIGN.md#s-6) |
| 리컨실러 | 워커가 N초마다 MySQL에서 최근 바뀐 행을 읽어 Redis와 다르면 다시 반영하는 잡(L2) | [01_DESIGN 6.2](01_DESIGN.md#s-6-2) |
| 동기화 시각 (`synced_at`) | 리컨실러가 "이 시각까지 바뀐 행은 Redis에 맞췄다"고 남기는 `updated_at` 기준 시각. MySQL `job_state.synced_at`과 Redis 센티넬 값에 함께 둔다 | [01_DESIGN 6.2](01_DESIGN.md#s-6-2) |
| 재구축 | Redis 순위표를 MySQL에서 처음부터 다시 만드는 것(L3) | [01_DESIGN 6.3](01_DESIGN.md#s-6-3) |
| 안전마진 (`RECOVERY_MARGIN_SEC`) | 리컨실러가 동기화 시각보다 이만큼 앞부터 다시 읽는 여유. 기본 60초이고, 최대 트랜잭션 시간보다 길어야 한다 | [01_DESIGN 6.2](01_DESIGN.md#s-6-2) |
| 청크 / 키셋 | 청크는 대량의 행을 일정 개수씩 나눠 처리하는 단위다. 키셋은 마지막으로 읽은 키 다음부터 읽는 방식으로, `OFFSET`과 달리 뒤로 갈수록 느려지지 않는다 | [01_DESIGN 6.2](01_DESIGN.md#s-6-2) |
| 복구 잡 | 워커가 센티넬 없는 대상 시즌을 찾아 재구축(L3)하고 센티넬을 설정하는 잡. 시작 60초 전 시즌도 대상이라, 비어 있으면 센티넬만 설정한다 | [01_DESIGN 5.3](01_DESIGN.md#s-5-3), [6.3](01_DESIGN.md#s-6-3) |
| 보조 점검 | 시즌마다 1시간에 한 번 순위표 인원과 MySQL 인원을 비교해, 순위표가 모자라면 L2로 다시 채우는 점검 | [01_DESIGN 6.4](01_DESIGN.md#s-6-4) |
| ZSET / HASH | Redis 자료형. ZSET은 점수순으로 정렬되는 집합(순위표), HASH는 필드·값 묶음이다 | [01_DESIGN 5.1](01_DESIGN.md#s-5-1) |
| version 경로 (version Lua, version HASH) | SUM 랭킹의 Redis 반영 방식. HASH에 멤버별 `version`을 두고, 늦게 도착한 옛 값은 Lua가 버린다 | [01_DESIGN 5.3](01_DESIGN.md#s-5-3) |
| RDB / AOF | Redis 저장 방식. RDB는 주기적 스냅샷이고 기본값이다. AOF는 쓰기 기록 방식이며 쓰지 않는다 | [D-04](02_DECISIONS.md#d-04) |

## 프로세스와 운영

| 용어 | 뜻 | 상세 |
| --- | --- | --- |
| API / 워커 / 관리 API | 같은 코드베이스의 세 프로세스. API는 게임 서버 요청, 워커는 주기 잡(스케줄러·리컨실러·정산 등), 관리 API는 GM 기능을 맡는다 | [09_OPERATIONS 1](09_OPERATIONS.md#1-프로세스) |
| 잡 | 워커가 주기적으로 돌리는 작업. 잡마다 `GET_LOCK`으로 워커 여러 대 중 한 곳에서만 돈다 | [01_DESIGN 11.3](01_DESIGN.md#s-11-3) |
| 정체 감시 | 정리 잡(백업 분리, 로그 정리)의 마지막 성공이 3시간보다 오래되면 경고하는 감시 | [01_DESIGN 11.4](01_DESIGN.md#s-11-4) |
| 관리 역할 (viewer / operator / admin) | 관리 API 계정의 권한. viewer는 조회, operator는 GM 조작, admin은 operator 권한에 계정 관리를 더한다 | [01_DESIGN 10.4](01_DESIGN.md#s-10-4) |
| 감사 로그 | 관리 API의 모든 조작(실패 포함)을 누가, 언제, 무엇을 바꿨는지 남기는 로그 DB 기록 | [01_DESIGN 10.4](01_DESIGN.md#s-10-4) |
| 하트비트 | API·워커·관리 API가 10초마다 "살아 있다"고 DB에 남기는 행. migrate는 이것이 있으면 실행을 거부한다 | [01_DESIGN 11.4](01_DESIGN.md#s-11-4) |
| 중단 패치 / 롤링 | 중단 패치: 전체 중지 → migrate → 기동(DB 변경이 있을 때). 롤링: 서버를 하나씩 교체(DB 변경이 없을 때) | [01_DESIGN 11.6](01_DESIGN.md#s-11-6), [09_OPERATIONS](09_OPERATIONS.md) |

## 측정

| 용어 | 뜻 | 상세 |
| --- | --- | --- |
| p50·p95·p99 | 응답 시간을 빠른 순으로 줄 세웠을 때 50%·95%·99% 지점의 값. p99 100ms는 "100건 중 99건이 100ms 안에 끝났다"는 뜻 | — |
| N+1 (서버 대수) | 필요한 대수 N에 장애·배포 대비 1대를 더 두는 것. ORM의 "N+1 쿼리 문제"와 무관하다 | — |
| MAU / DAU | 월간·일간 활성 이용자 수. 규모 목표의 기준이다 | [01_DESIGN 1.7](01_DESIGN.md#s-1-7) |
