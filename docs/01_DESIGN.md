# Podium DE — 설계

## 1. 개요

### 1.1 목적

게임 프로젝트에 시즌 기반 랭킹과 정산, 보상 전달을 제공하는 범용 랭킹 플랫폼.

- 스코어는 의미 없는 정수로 취급한다. 타임어택, 획득 점수, 포인트 등은 랭킹 정의(갱신 규칙, 정렬 방향, 범위)의 조합으로 표현한다.
- 랭킹 서버는 게임 도메인을 알지 않는다. 보상은 `reward_code`만 판정하며, 실제 지급은 게임 서버가 담당한다.

### 1.2 배포 모델

**싱글테넌트, 프로젝트별 독립 배포 (Dedicated Edition).**

- 설치본 하나가 게임 프로젝트 하나를 담당한다.
- 테넌트 식별자(`project_id` 등)는 두지 않는다.
- 설치본 내부에는 여러 랭킹이 존재할 수 있으며, 각 랭킹은 독립된 시즌 일정을 갖는다.

### 1.3 기술 스택

| 구성 | 버전 | 역할 |
| --- | --- | --- |
| Node.js | 22 LTS | API, 스케줄러 |
| Fastify | 5 | HTTP 서버, 요청 스키마 검증, Swagger 문서 |
| node-redis | 5 | Redis 클라이언트 (클러스터, Lua) |
| MySQL | 8.4 | 원장. 모든 DB 로직은 Stored Procedure |
| Redis | 7.4 | 실시간 랭킹 (MySQL의 투영) |

### 1.4 명명 규칙

| 대상 | 표기 |
| --- | --- |
| 제품명 | Podium DE |
| DB 스키마 | `podium_de` |
| 저장소, 패키지, 이미지, 호스트명 | `podium-de` |

### 1.5 핵심 원칙

1. **MySQL이 원장이고 Redis는 투영이다.** Redis 값은 MySQL 행 하나와 랭킹 정의만으로 결정적으로 계산된다. 따라서 Redis는 언제든 재구축할 수 있다.
2. **상태 전이는 시각과 관측에 묶는다.** 마감, 정산 시작, 검수 종료는 잡 실행 여부가 아니라 시각으로 결정한다. 각 단계는 실제 상태를 관측해 판단하고 멱등하게 실행한다.
3. **유저 행동에 의존하는 진행 조건을 두지 않는다.** 데이터 이동과 정리는 시스템이 스스로 진행시킬 수 있는 조건만 사용한다.
4. **자동으로 해결되지 않으면 알린다.** 재시도로 풀리지 않는 상태는 멈추고 알림을 보낸다. 파괴적 작업은 검증 실패 시 실행하지 않는다.
5. **운영 테이블에서 무거운 작업을 하지 않는다.** 운영 테이블의 DDL은 메타데이터 수준으로 제한하고, 대량 읽기·쓰기는 분리된 테이블에서 수행한다.

---

## 2. 랭킹 정의

관리자가 등록한다.

### 2.1 ranking_definition

```sql
CREATE TABLE `ranking_definition` (
    `ranking_id`            INT             UNSIGNED               NOT NULL                    COMMENT '랭킹 ID (1부터)',
    `ranking_code`          VARCHAR(64)     COLLATE utf8mb4_bin    NOT NULL                    COMMENT '랭킹 코드 (게임 서버 식별용, 대소문자 구분)',
    `ranking_name`          VARCHAR(128)                           NOT NULL                    COMMENT '랭킹 이름',
    `status`                TINYINT         UNSIGNED               NOT NULL                    COMMENT '상태 (1:ACTIVE 운영, 2:PAUSED 일시 중지, 3:ENDED 종료 — ACTIVE가 아니면 제출 거부) [codes.RankingStatus]',
    `update_rule`           TINYINT         UNSIGNED               NOT NULL                    COMMENT '갱신 규칙, 등록 후 불변 (1:BEST 최고 기록, 2:SUM 부호 있는 증분 누적, 3:LATEST 최신 값 — 2차 범위, 등록 거부) [codes.UpdateRule]',
    `sort_order`            TINYINT         UNSIGNED               NOT NULL                    COMMENT '정렬 방향, 등록 후 불변 (1:DESC 큰 값이 위, 2:ASC 작은 값이 위) [codes.SortOrder]',
    `score_max`             BIGINT          UNSIGNED               NOT NULL                    COMMENT '스코어 허용 상한이자 비트 예산 기준',
    `time_unit`             TINYINT         UNSIGNED               NOT NULL                    COMMENT '동점 처리(먼저 달성한 쪽이 위) 시간 단위, 등록 후 불변 (1:MS 밀리초, 2:SEC 초, 3:MIN 분, 4:DAY 일) [codes.TimeUnit]',
    `time_bits`             TINYINT         UNSIGNED               NOT NULL                    COMMENT 'composite score의 시간 비트 수 (등록 시 계산)',
    `timezone`              VARCHAR(64)                            NOT NULL                    COMMENT '시즌 경계 계산 기준 시간대 (예: Asia/Seoul)',
    `start_at`              DATETIME(3)                            NOT NULL                    COMMENT '랭킹 시작 시각 (UTC)',
    `end_at`                DATETIME(3)                                        DEFAULT NULL    COMMENT '랭킹 종료 시각 (UTC, NULL:영구 랭킹)',
    `cycle_type`            TINYINT         UNSIGNED               NOT NULL                    COMMENT '시즌 주기 (0:NONE 반복 없음 — end_at 있으면 단일 시즌, 없으면 영구, 1:DAILY, 2:WEEKLY, 3:MONTHLY — timezone 기준 달력 경계, 4:FIXED start_at부터 cycle_value초 고정 길이) [codes.CycleType]',
    `cycle_value`           INT             UNSIGNED                           DEFAULT NULL    COMMENT '고정 주기 길이 (초, cycle_type=FIXED일 때만)',
    `settle_delay`          INT             UNSIGNED               NOT NULL                    COMMENT '시즌 종료 → 정산 시작 유예 (초)',
    `wait_period`           INT             UNSIGNED               NOT NULL    DEFAULT 0       COMMENT '시즌 종료 → 다음 시즌 시작 대기 (초)',
    `review_period`         INT             UNSIGNED               NOT NULL                    COMMENT '검수 기간 (초)',
    `hall_size`             SMALLINT        UNSIGNED               NOT NULL    DEFAULT 100     COMMENT 'ranking_hall에 영구 보관할 시즌별 상위 인원',
    `history_retention`     INT             UNSIGNED               NOT NULL                    COMMENT '시즌별 백업 테이블 보관 기간 (일)',
    `max_delta`             BIGINT          UNSIGNED                           DEFAULT NULL    COMMENT 'SUM 1회 최대 증분 (NULL:제한 없음)',
    `max_submit_per_min`    INT             UNSIGNED                           DEFAULT NULL    COMMENT '멤버별 분당 최대 제출 수 (NULL:제한 없음)',
    `suspicion_config`      JSON                                               DEFAULT NULL    COMMENT '어뷰징 탐지 규칙별 가중치, 보상 보류 임계치',
    `created_at`            DATETIME(3)                            NOT NULL                    COMMENT '등록 시각 (UTC)',
    `updated_at`            DATETIME(3)                            NOT NULL                    COMMENT '수정 시각 (UTC)',
    PRIMARY KEY (`ranking_id`),
    UNIQUE KEY `uk_ranking_code` (`ranking_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='랭킹 정의';
```

### 2.2 순위 규칙

| 필드 | 의미 |
| --- | --- |
| `update_rule` | 값을 어떻게 갱신하는가 |
| `sort_order` | 큰 값이 위인가(DESC), 작은 값이 위인가(ASC) |
| `score_max` | 허용 범위이자 비트 예산의 기준 |
| `time_unit` | 동점 처리(먼저 달성한 쪽이 위)에 쓰는 시간 단위 |

순위 규칙은 등록 후 변경할 수 없다. 변경이 필요하면 새 랭킹을 등록한다.

### 2.3 갱신 규칙

| 규칙 | 게임 서버 입력 | 계산 | Redis 반영 | 비고 |
| --- | --- | --- | --- | --- |
| BEST | 이번 기록 | `GREATEST(score, 입력)` | `ZADD GT` (ASC는 `LT`) | 최고 기록 |
| SUM | 부호 있는 증분 | `GREATEST(score + 입력, 0)` | version Lua | 멱등 키 필수 |
| LATEST | 현재 값 + 소스 시퀀스 | 시퀀스가 클 때만 덮어씀 | version Lua | 2차 범위 |

- 값이 실제로 바뀌지 않으면 `version`, `achieved_at`, `updated_at`을 갱신하지 않는다. (예: 0점에서 음수 증분)
- SUM 결과가 `score_max`를 넘으면 거부한다. 거부 사유는 멱등 키(`rejected`)와 제출 이력에 남긴다.
- SUM 첫 제출의 증분이 0 이하면 entry 행을 만들지 않고 로그에만 남긴다. 0점 유저가 참가자 수와 PERCENT 구간 계산에 섞이지 않게 한다. 응답은 성공(`RESULT 0`)이며 `score = 0`, `version = 0`, `achieved_at = NULL`이다. 앱은 `version = 0`이면 Redis 반영을 건너뛴다 (D-32).
- LATEST는 코드(3)만 정의하고, 구현 전까지 등록을 거부한다.

| 랭킹 예시 | 규칙 | 정렬 |
| --- | --- | --- |
| 스테이지 최고 점수 | BEST | DESC |
| 타임어택 최단 기록 | BEST | ASC |
| 이벤트 포인트, 누적 처치 수 | SUM | DESC |
| PvP 트로피, 레이팅 | SUM (음수 증분) | DESC |
| 전투력, 레벨 | LATEST | DESC |

### 2.4 비트 예산

Redis ZSET score(double)는 2^53까지 정수를 정확히 표현한다. 이를 점수 비트와 시간 비트로 나눈다.

```text
bits(score_max) + time_bits ≤ 53
time_bits = bits(최대 시즌 길이 / time_unit)
```

- MONTHLY는 31일 기준으로 계산한다.
- 영구 랭킹은 최소 30년을 커버하도록 계산한다.
- 예산을 초과하면 등록을 거부한다.

| time_unit | 커버 기간 | time_bits | score_max 상한 |
| --- | --- | --- | --- |
| SEC | 1년 | 25 | 약 2.68억 |
| SEC | 3개월 | 23 | 약 10.7억 |
| MS | 1개월 | 32 | 약 209만 |
| MIN | 약 63년 | 25 | 약 2.68억 |
| DAY | 약 89년 | 15 | 약 2,750억 |

시즌 주기별 `score_max` 상한 (DAILY 1일, WEEKLY 7일, MONTHLY 31일 기준):

| time_unit | DAILY | WEEKLY | MONTHLY |
| --- | --- | --- | --- |
| MS | 약 6,710만 | 약 838만 | 약 209만 |
| SEC | 약 687억 | 약 85.9억 | 약 21억 |
| MIN | 약 4.4조 | 약 5,497억 | 약 1,374억 |

- 시간 단위가 거칠수록 점수 범위가 넓어지는 대신, 같은 단위 안의 동점은 멤버 사전순이 된다(5.2).
- 1억 점까지 받아야 하면 대부분 SEC로 충분하다(시즌 약 2년까지).

스코어는 정수만 받는다. 소수 값은 게임 서버가 스케일을 곱해 정수로 보낸다.

### 2.5 랭킹 유형

| 조건 | 유형 | 정산 / 보상 / 아카이브 |
| --- | --- | --- |
| `cycle_type ≠ NONE` | 시즌 랭킹 | 있음 |
| `cycle_type = NONE`, `end_at` 있음 | 이벤트 랭킹 (단일 시즌) | 있음 |
| `cycle_type = NONE`, `end_at` NULL | 영구 랭킹 | 없음 |

- 시즌 랭킹에 `end_at`이 있으면 그 시각까지만 시즌을 만든다. 예: 하루 이벤트를 8시간 주기(`FIXED`, 28800)로 두면 시즌 3개가 각각 정산·보상된다.

### 2.6 보상 구간

```sql
CREATE TABLE `ranking_reward_tier` (
    `ranking_id`     INT            UNSIGNED               NOT NULL        COMMENT '랭킹 ID (ranking_definition, FK 없음)',
    `tier_no`        SMALLINT       UNSIGNED               NOT NULL        COMMENT '구간 번호 (랭킹 안에서 유일)',
    `range_type`     TINYINT        UNSIGNED               NOT NULL        COMMENT '구간 기준 (1:RANK 순위, 2:PERCENT 제재 제외 참가자 수 대비 백분율) [codes.RangeType]',
    `range_from`     INT            UNSIGNED               NOT NULL        COMMENT '구간 시작 (포함)',
    `range_to`       INT            UNSIGNED               NOT NULL        COMMENT '구간 끝 (포함)',
    `reward_code`    VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL        COMMENT '보상 코드 (게임 서버가 해석, 대소문자 구분)',
    PRIMARY KEY (`ranking_id`, `tier_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='랭킹별 보상 구간';
```

- `reward_code`는 게임 서버가 해석하는 코드이며, 랭킹 서버는 의미를 알지 않는다.
- 정산 시점에 적용된 구간은 시즌에 고정한다.
- PERCENT 구간은 제재 유저를 제외한 참가자 수 기준으로 계산한다.

### 2.7 등록 검증

- 비트 예산 (2.4)
- 단일 시즌 랭킹: `wait_period`는 의미 없음 (보상은 일괄 전달)
- `cycle_type = FIXED`이면 `cycle_value` 필수(1 이상), 그 외에는 NULL
- 시즌 랭킹: `정산 시작 지연 + review_period < 시즌 길이`가 아니면 거부한다. 이전 시즌의 정산 대기와 검수가 다음 시즌 종료 전에 끝나야 정산이 밀리지 않는다. 시즌 길이는 DAILY 1일, WEEKLY 7일, MONTHLY 28일(가장 짧은 달), FIXED `cycle_value`초
  - 정산 시작 지연 = `max(settle_delay, 리컨실러 안전마진 + 리컨실러 실행 주기)`. 정산은 `settle_at`과 함께 리컨실러 워터마크가 `end_at + 안전마진`을 넘어야 시작하므로(7.1, 6.2), `settle_delay`를 짧게 잡아도 이보다 일찍 시작하지 않는다
  - 안전마진과 실행 주기는 설정값이다. 짧은 주기로 테스트할 때는 이 값도 함께 줄인다
- `wait_period`는 제한하지 않는다. 시즌 사이의 공백이라 정산과 겹치지 않는다 (예: 7일 시즌을 한 달에 한 번)
- 최소 주기는 두지 않는다. 주기가 짧을수록 시즌마다 운영 테이블 파티션 DDL(11.1)과 정산이 자주 일어난다
- 구현되지 않은 갱신 규칙 거부

---

## 3. 시즌

### 3.1 ranking_season

스케줄러가 정의를 기준으로 자동 생성한다.

```sql
CREATE TABLE `ranking_season` (
    `ranking_id`           INT             UNSIGNED    NOT NULL                    COMMENT '랭킹 ID (ranking_definition, FK 없음)',
    `season_no`            INT             UNSIGNED    NOT NULL                    COMMENT '시즌 번호 (랭킹 안에서 1부터)',
    `start_at`             DATETIME(3)                 NOT NULL                    COMMENT '시즌 시작 시각 (UTC, 포함)',
    `end_at`               DATETIME(3)                 NOT NULL                    COMMENT '시즌 종료 시각 (UTC, 미포함)',
    `settle_at`            DATETIME(3)                 NOT NULL                    COMMENT '정산 시작 하한 시각 (UTC, end_at + settle_delay)',
    `review_until`         DATETIME(3)                             DEFAULT NULL    COMMENT '검수 종료 시각 (UTC, 정산 결과 생성 후 확정)',
    `status`               TINYINT         UNSIGNED    NOT NULL                    COMMENT '상태, 진행 순서대로 증가 (1:SCHEDULED 예정, 2:OPEN 적재, 3:CLOSED 적재 차단, 4:SETTLING 가순위 생성, 5:REVIEW 검수, 6:FINALIZING 확정, 7:DELIVERING 보상 전달, 8:SETTLED 완료) [codes.SeasonStatus]',
    `review_hold`          TINYINT(1)                  NOT NULL    DEFAULT 0       COMMENT '검수 보류 (1:보류 — 해제 전까지 확정하지 않음, 0:없음)',
    `participant_count`    INT             UNSIGNED                DEFAULT NULL    COMMENT '제재 제외 후 확정 참가자 수 (FINALIZING에서 기록)',
    `tier_snapshot`        JSON                                    DEFAULT NULL    COMMENT '정산 시 적용된 보상 구간 스냅샷',
    `settled_at`           DATETIME(3)                             DEFAULT NULL    COMMENT '정산 완료(SETTLED) 시각 (UTC)',
    `forced_by`            VARCHAR(64)                             DEFAULT NULL    COMMENT 'DELIVERING 강제 종료한 GM 식별자 (NULL:정상 종료) — 남은 PENDING은 그대로 백업으로 분리됨',
    `forced_reason`        VARCHAR(255)                            DEFAULT NULL    COMMENT 'DELIVERING 강제 종료 사유',
    PRIMARY KEY (`ranking_id`, `season_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='랭킹별 시즌';
```

### 3.2 시즌 일정

```text
[시즌 N 기간] ── end_at ──[wait_period]── [시즌 N+1 기간] ...
                    └─[settle_delay]─▶ 정산 시작 (다음 시즌과 병렬)
```

- 시간은 UTC로 저장하고, 경계 계산만 `timezone` 기준으로 한다.
- 정산은 시즌 사이에 끼우지 않는다. 다음 시즌은 `end_at + wait_period`에 시작하고, 정산은 병렬로 진행된다.

### 3.3 자동 생성

- **등록 시:** `ranking_definition` INSERT와 같은 트랜잭션에서 첫 시즌들을 생성한다.
- **이후:** 스케줄러가 현재 시점부터 일정 주기 앞까지 시즌 행을 유지한다. `INSERT IGNORE`로 멱등하게 처리한다.
- **시즌 행 생성 시:** 해당 `(ranking_id, season_no)` 파티션을 `ranking_entry`, `ranking_submit_key`에 추가한다.
- **OPEN 전이 시:** Redis 센티넬(`:ready`)을 설정한다 (5.3).

### 3.4 관리자 수정 범위

| 시즌 상태 | 허용 |
| --- | --- |
| SCHEDULED | 자유 수정 |
| OPEN | `end_at` 변경만. 과거 시각으로 변경 불가 |
| CLOSED 이후 | 수정 불가 |

`end_at` 변경 시 이후 SCHEDULED 시즌의 일정 재계산 여부는 정책으로 정한다.

### 3.5 상태 흐름

```text
SCHEDULED ──start_at──▶ OPEN ──end_at──▶ CLOSED ──settle_at + 확인──▶ SETTLING
  ──▶ REVIEW ──review_until (보류 없음)──▶ FINALIZING ──▶ DELIVERING ──▶ SETTLED
```

| 상태 | 내용 |
| --- | --- |
| OPEN | 스코어 적재 |
| CLOSED | 적재 차단 (시각 검사로 보장) |
| SETTLING | entry 파티션을 작업 테이블로 꺼내 가순위 생성 후 되돌림 |
| REVIEW | 검수. 제재 반영 가능, 지급 없음 |
| FINALIZING | 제재 제외, 순위 재부여, 보상 판정, hall 적재 |
| DELIVERING | 게임 서버가 보상 목록 수신 및 ack |
| SETTLED | 완료 |

**쓰기 차단은 상태가 아니라 시각으로 한다.** SP가 `NOW(3)`이 `[start_at, end_at)` 안인지 직접 검사한다. 상태 전이 잡이 늦어도 마감은 정확하다.

---

## 4. 스코어 적재

### 4.1 흐름

```text
게임 서버 ──x-api-key──▶ API  (memberId, value, seasonNo, requestId, meta?)
  1. 제출 빈도 검사 (Redis, 초과 시 2006 — Redis 장애 시 통과)
  2. SP_SUBMIT_SCORE
       랭킹 상태 검사 (ACTIVE)
       시즌 검사: seasonNo = 현재 OPEN 시즌 (시각 기준)
       멱등 키 확인 (해당 시즌의 ranking_submit_key)
       하드 검증 (범위, max_delta, score_max)
       규칙 적용 upsert
       멱등 키 기록 (같은 트랜잭션)
       결과 반환 (RESULT, season_no, season_start_at, score, achieved_at, version, replayed)
  3. composite 계산 → Redis 반영 (실패해도 응답은 성공, version = 0이면 생략)
  4. 제출 이력 기록 → 로그 DB (인증·형식 검사를 통과한 요청의 모든 결과, 실패해도 응답에 영향 없음, 4.5)
```

**시즌 번호는 필수다.** 게임 서버는 플레이 시작 시점의 시즌 번호를 기억해 제출 시 함께 보낸다.

API는 랭킹 정의(순위 규칙, `max_submit_per_min`)를 메모리에 두고 30초마다 다시 읽는다(D-56). 빈도 검사가 SP보다 먼저이고, composite 계산과 순위 조회에도 순위 규칙이 필요하기 때문이다. 캐시에 없는 랭킹은 SP를 부르지 않고 1101로 거부한다. 새 랭킹은 최대 30초 뒤부터 제출을 받는다.

- 전달받은 시즌이 현재 OPEN 시즌과 다르면 `SEASON_MISMATCH`로 거부한다.
- `wait_period = 0`이면 시즌 N 종료 직후 N+1이 바로 열린다. 시즌 번호가 없으면 시즌 N에서 시작한 플레이가 N+1에 반영된다. 시즌 번호 검사로 이를 막는다.
- 과거 시즌 번호는 시각 검사에서 거부되므로 조작할 수 없다.

| 결과 | 조건 |
| --- | --- |
| 성공 | 반영됨 (`replayed = 0`) |
| 재전송 | 같은 `requestId`, 같은 내용 → 현재 entry 상태 반환 (`replayed = 1`) |
| `RANKING_INACTIVE` | 랭킹 상태가 ACTIVE 아님 |
| `SEASON_MISMATCH` | 시즌 불일치, 또는 재전송 시 해당 시즌 멱등 키가 이미 정리됨 |
| `IDEMPOTENCY_CONFLICT` | 같은 `requestId`, 다른 내용 |
| 하드 검증 거부 | 범위 초과, `max_delta` 초과, SUM 결과 `score_max` 초과 |

멱등 키는 반영 성공과 하드 검증 거부만 기록한다. 하드 검증 거부는 `rejected`와 함께 기록하며, 같은 키로 재전송되면 같은 거부를 반환한다. 시즌 밖 제출, `SEASON_MISMATCH` 등은 멱등 키 없이 결과 코드만 반환한다. 제출 이력(로그 DB)에는 인증과 요청 형식 검사를 통과한 제출을 결과와 무관하게 모두 남긴다. 인증 실패(2002, 2003)와 형식 오류(2001)는 앱 로그의 요청·응답 줄로만 남는다.

- "같은 내용"은 `member_id`와 `input_value`가 같다는 뜻이다. `meta`는 맥락 정보라 비교하지 않는다.

- `achieved_at`은 MySQL 마스터의 `NOW(3)`으로 기록한다. Redis나 게임 서버 시각을 사용하지 않는다.
- 앱은 커넥션마다 세션 `time_zone`을 `+00:00`으로 고정한다.

### 4.2 ranking_entry

```sql
CREATE TABLE `ranking_entry` (
    `ranking_id`       INT            UNSIGNED               NOT NULL                    COMMENT '랭킹 ID (ranking_definition, FK 없음 — 파티션 테이블은 FK 불가)',
    `season_no`        INT            UNSIGNED               NOT NULL                    COMMENT '시즌 번호 (ranking_season)',
    `member_id`        VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                    COMMENT '멤버 ID (게임 서버 식별자, 대소문자 구분)',
    `score`            BIGINT         UNSIGNED               NOT NULL                    COMMENT '스코어 (진행 중 현재 값, 마감 후 최종 값)',
    `achieved_at`      DATETIME(3)                           NOT NULL                    COMMENT '현재 스코어 달성 시각 (UTC, MySQL NOW(3)) — 동점 시 먼저 달성한 쪽이 위',
    `version`          INT            UNSIGNED               NOT NULL    DEFAULT 1       COMMENT '값 변경 버전 (실제로 바뀔 때만 증가, Redis 반영 순서 비교용)',
    `source_seq`       BIGINT         UNSIGNED                           DEFAULT NULL    COMMENT '게임 서버 소스 시퀀스 (LATEST 전용, 2차 범위)',
    `updated_at`       DATETIME(3)                           NOT NULL                    COMMENT '값 변경 시각 (UTC, 실제로 바뀔 때만 갱신) — 리컨실러 워터마크 스캔 기준',
    `final_rank`       INT            UNSIGNED                           DEFAULT NULL    COMMENT '순위 (SETTLING 가순위, FINALIZING 확정. NULL:미산정 또는 제재 제외)',
    `reward_code`      VARCHAR(64)    COLLATE utf8mb4_bin                DEFAULT NULL    COMMENT '판정된 보상 코드 (NULL:미판정 또는 구간 밖, 대소문자 구분)',
    `reward_status`    TINYINT        UNSIGNED               NOT NULL    DEFAULT 0       COMMENT '보상 상태 (0:NONE 미판정 또는 구간 밖, 1:PENDING 전달 전, 2:DELIVERED 게임 서버 ack 완료, 3:REJECTED 제재로 미지급) [codes.RewardStatus]',
    `reward_held`      TINYINT(1)                            NOT NULL    DEFAULT 0       COMMENT '보상 보류 (1:어뷰징 포인트 임계치 초과로 보류, 0:없음)',
    `sanctioned`       TINYINT(1)                            NOT NULL    DEFAULT 0       COMMENT '제재 표시 (1:제재됨, 0:없음) — 보상 상태와 별개',
    `delivered_at`     DATETIME(3)                                       DEFAULT NULL    COMMENT '보상 전달 ack 시각 (UTC)',
    PRIMARY KEY (`ranking_id`, `season_no`, `member_id`),
    KEY `ix_updated_at` (`ranking_id`, `season_no`, `updated_at`),
    KEY `ix_final_rank` (`ranking_id`, `season_no`, `final_rank`),
    KEY `ix_reward_status` (`ranking_id`, `season_no`, `reward_status`, `member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='시즌별 멤버 스코어와 정산 결과 (운영 테이블, 시즌 파티션)'
PARTITION BY LIST COLUMNS (`ranking_id`, `season_no`) (
    PARTITION `p_init` VALUES IN ((0, 0))
);
```

- 시즌의 스코어와 정산 결과를 한 행에 둔다. 결과 컬럼(`final_rank`~`delivered_at`)은 진행 중에는 비어 있고, 정산 단계에서 채운다 (7.3~7.7, D-49).
- 시즌 데이터는 결과가 백업으로 분리될 때(자기 시즌과 다음 시즌 모두 SETTLED, 마지막 시즌은 자기 시즌 SETTLED)까지 보관한다 (8.2).
- 제출이 결과 컬럼을 건드리지 않으므로 결과 인덱스(`ix_final_rank`, `ix_reward_status`)는 신규 멤버 INSERT 때만 비용이 든다.
- LIST 파티션 테이블은 생성 시 파티션이 최소 하나 필요하므로 `p_init ((0,0))`을 둔다. `ranking_id`는 1부터 시작한다. `ranking_submit_key`도 동일하다.
- 정의되지 않은 `(ranking_id, season_no)`는 INSERT 시 에러가 발생한다. 잘못된 파티션에 조용히 들어가는 것을 방지한다.

### 4.3 BEST upsert

```sql
INSERT INTO ranking_entry
  (ranking_id, season_no, member_id, score, achieved_at, version, updated_at)
VALUES (?, ?, ?, ?, NOW(3), 1, NOW(3)) AS n
ON DUPLICATE KEY UPDATE
  achieved_at = IF(n.score > ranking_entry.score, n.achieved_at, ranking_entry.achieved_at),
  version     = IF(n.score > ranking_entry.score, ranking_entry.version + 1, ranking_entry.version),
  updated_at  = IF(n.score > ranking_entry.score, n.updated_at, ranking_entry.updated_at),
  score       = GREATEST(ranking_entry.score, n.score);   -- 반드시 마지막
```

ODKU는 왼쪽부터 평가되므로 `score`를 마지막에 둔다. ASC 정렬이면 비교 방향을 반대로 한다.

### 4.4 ranking_submit_key

멱등 키 확인 전용이다. 반영과 같은 트랜잭션에서 기록해야 하므로 메인 DB에 둔다. 제출 이력은 로그 DB에 따로 남긴다 (4.5, D-48).

```sql
CREATE TABLE `ranking_submit_key` (
    `ranking_id`     INT            UNSIGNED               NOT NULL                    COMMENT '랭킹 ID (ranking_definition, FK 없음 — 파티션 테이블은 FK 불가)',
    `season_no`      INT            UNSIGNED               NOT NULL                    COMMENT '시즌 번호 (제출 요청의 seasonNo)',
    `request_id`     VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                    COMMENT '멱등 키 (게임 서버 requestId, 대소문자 구분)',
    `member_id`      VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                    COMMENT '멤버 ID (같은 내용 비교, 검수 목록, 대소문자 구분)',
    `input_value`    BIGINT                                NOT NULL                    COMMENT '입력 값 (같은 내용 비교, BEST:이번 기록, SUM:부호 있는 증분)',
    `rejected`       VARCHAR(32)                                       DEFAULT NULL    COMMENT '하드 검증 거부 사유 (NULL:반영됨) — 재전송 시 같은 거부 반환, 검수 목록',
    `created_at`     DATETIME(3)                           NOT NULL                    COMMENT '처리 시각 (UTC)',
    PRIMARY KEY (`ranking_id`, `season_no`, `request_id`),
    KEY `ix_member_id` (`ranking_id`, `season_no`, `member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='제출 멱등 키 (시즌 파티션)'
PARTITION BY LIST COLUMNS (`ranking_id`, `season_no`) (
    PARTITION `p_init` VALUES IN ((0, 0))
);
```

- 멱등 키 조회는 전달받은 `season_no`의 파티션에서 한다.
- 같은 `request_id`가 같은 내용으로 오면 반영하지 않고 **현재 entry 상태**를 반환하며, 다른 내용이면 `IDEMPOTENCY_CONFLICT`로 거부한다.
- 재전송 응답이 처리 당시 결과가 아니라 현재 상태인 이유: 앱은 응답으로 Redis를 반영하므로, 최신 행이어야 version 비교가 맞게 동작한다.
- `meta`, `result_score` 같은 이력 컬럼은 두지 않는다. 행을 작게 유지하는 것이 이 테이블을 분리한 목적이다.
- 검수 근거(`rejected`)로 SETTLED까지 유지한다.

### 4.5 log_ranking_submit (로그 DB)

인증과 요청 형식 검사를 통과한 모든 제출 요청의 처리 결과 이력이다. 감사, 어뷰징 조사, 장애 조사에 쓴다. 로그 DB `podium_de_log`에 둔다.

```sql
CREATE TABLE `log_ranking_submit` (
    `log_ranking_submit_id`    BIGINT         UNSIGNED               NOT NULL    AUTO_INCREMENT    COMMENT '로그 ID',
    `created_at`               DATETIME(3)                           NOT NULL                      COMMENT '기록 시각 (UTC, 로그 DB 시각) — 파티션 키',
    `ranking_id`               INT            UNSIGNED               NOT NULL                      COMMENT '랭킹 ID (메인 DB ranking_definition, FK 없음 — 물리 분리 DB)',
    `season_no`                INT            UNSIGNED               NOT NULL                      COMMENT '요청의 seasonNo',
    `request_id`               VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                      COMMENT '멱등 키 (게임 서버 requestId, 대소문자 구분)',
    `member_id`                VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                      COMMENT '멤버 ID (대소문자 구분)',
    `input_value`              BIGINT                                NOT NULL                      COMMENT '입력 값 (BEST:이번 기록, SUM:부호 있는 증분)',
    `result_code`              INT            UNSIGNED               NOT NULL                      COMMENT '처리 결과 (0:성공, 그 외 API 결과 코드)',
    `rejected`                 VARCHAR(32)                                       DEFAULT NULL      COMMENT '하드 검증 거부 사유',
    `replayed`                 TINYINT(1)                            NOT NULL    DEFAULT 0         COMMENT '재전송 여부 (1:재전송, 0:최초)',
    `result_score`             BIGINT         UNSIGNED                           DEFAULT NULL      COMMENT '처리 후 스코어 (SP까지 간 경우)',
    `version`                  INT            UNSIGNED                           DEFAULT NULL      COMMENT '처리 후 entry version (SP까지 간 경우)',
    `meta`                     JSON                                              DEFAULT NULL      COMMENT '게임 서버 맥락 (매치 ID 등, 해석하지 않음)',
    PRIMARY KEY (`log_ranking_submit_id`, `created_at`),
    KEY `ix_member_id` (`ranking_id`, `member_id`, `created_at`),
    KEY `ix_request_id` (`request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='제출 처리 이력 (로그 DB, 일 단위 파티션)'
PARTITION BY RANGE COLUMNS (`created_at`) (
    PARTITION `p_max` VALUES LESS THAN (MAXVALUE)
);
```

- 앱이 응답을 만든 뒤 로그 DB 전용 커넥션 풀로 `SP_INSERT_LOG_RANKING_SUBMIT`을 호출해 기록한다. 메인 트랜잭션과 묶지 않으며, 실패해도 응답과 재시도에 영향이 없다 (개발 컨벤션 7장). 실패하면 앱 로그 파일에 같은 내용을 한 줄 남긴다. `meta`는 게임 서버가 보낸 임의 값이라 요청 로그와 같은 민감 키 마스킹과 5000자 자르기를 거친다.
- 정상 종료 시 진행 중인 적재가 끝나기를 기다린 뒤 로그 DB 풀을 닫는다. 응답은 나갔지만 아직 커넥션을 받지 못한 적재가 풀 종료로 유실되지 않게 한다.
- 인증 실패와 형식 오류는 남기지 않는다. 형식 오류는 NOT NULL 컬럼(`member_id`, `request_id` 등)을 채울 수 없는 경우가 있고, 인증 실패는 아직 제출로 볼 수 없다. 둘 다 앱 로그의 요청·응답 줄에 남는다.
- 제출 바디는 16KB로 제한한다. `meta`가 해석 없이 그대로 쌓이므로 기본값(1MiB)보다 작게 둔다.
- 보관은 시즌과 무관하게 날짜 기준이다(`LOG_RETENTION_DAYS`). 워커의 로그 정리 잡이 매일 다음 며칠의 일 파티션을 `p_max`에서 떼어 만들고(`SP_LOG_PARTITION_ADD`), 보관 기간이 지난 일 파티션을 DROP한다(`SP_LOG_PARTITION_DROP`). 로그 DB는 서비스 경로가 아니므로 데이터가 찬 파티션을 DROP해도 된다.
- `p_max`는 안전망이다. 정리 잡이 멈춰도 INSERT가 실패하지 않는다. `p_max`에 행이 쌓이면 정리 잡 이상으로 보고 알린다 (11.4).
- 조사 목적의 임의 조회는 이 테이블에서 한다. 메인 DB 운영 테이블에는 하지 않는다.
- 로그 DB에는 자기 `SP_EXEC_DDL`의 감사 로그용으로 `log_ddl_audit`를 하나 더 둔다. 구조는 메인과 같다 (11.4). 감사 로그는 DDL을 실행한 DB에 기록해야 하고, 로그 DB는 별도 인스턴스일 수 있기 때문이다.

---

## 5. 실시간 랭킹 (Redis)

### 5.1 키

| 키 | 타입 | 용도 |
| --- | --- | --- |
| `rk:{rankingId}:s:{seasonNo}` | ZSET | 순위표 |
| `rk:{rankingId}:s:{seasonNo}:ver` | HASH | member별 version (SUM, LATEST) |
| `rk:{rankingId}:s:{seasonNo}:ready` | STRING | 쓰기 허용 센티넬 (5.3) |
| `rk:{rankingId}:rl:{memberId}` | STRING | 제출 빈도 카운터 (TTL) |

`{rankingId}` 해시태그로 한 랭킹의 키를 같은 클러스터 슬롯에 둔다.

모든 키 앞에 `REDIS_KEY_PREFIX`(예: `ped:`)를 붙인다. Redis를 다른 서비스와 함께 쓸 때 키 충돌을 막는다. 예: `ped:rk:{1}:s:5`.

### 5.2 composite

```text
t = floor((achieved_at - season.start_at) / time_unit)
B = 2^time_bits

DESC: composite = score × B + (B − 1 − t)
ASC:  composite = score × B + t

디코드
DESC: score = floor(c / B),  t = (B − 1) − (c mod B)
ASC:  score = floor(c / B),  t = c mod B
```

- 같은 점수면 먼저 달성한 쪽이 위에 온다.
- 순위는 모두 고유하다. 같은 시간 단위 안에서 같은 점수가 나오면 Redis가 member 사전순(DESC 조회 시 역순)으로 정렬한다.
- 정산의 최종 순위도 같은 시간 슬롯과 member 순서로 정렬한다 (7.3, D-57).
- 계산 결과가 2^53 이상이면 앱은 예외로 처리하고 Redis에 쓰지 않는다. 정밀도를 잃은 값은 동점 순서를 소리 없이 틀리게 하기 때문이다. 제출 응답은 성공(원장 반영)이며 리컨실러가 따라잡는다. 정상이라면 등록 시 비트 예산 검증(2.4)이 이 상황을 막는다.

### 5.3 반영 경로

모든 반영은 Lua로 하며, **센티넬(`:ready`)이 있을 때만 쓴다.**

| 규칙 | 반영 |
| --- | --- |
| BEST | 센티넬 확인 → `ZADD key GT CH composite member` (ASC는 `LT`) |
| SUM, LATEST | 센티넬 확인 → version 비교 → `ZADD` |

BEST는 더 좋은 기록일수록 composite가 DESC면 커지고 ASC면 작아지므로, `GT`(ASC는 `LT`)가 늦게 도착한 이전 값을 거부한다. 같은 점수를 나중에 다시 달성하면 composite가 나빠지는 쪽으로 바뀌어 원래 달성 시각이 유지된다.

```lua
-- version Lua
-- KEYS[1] = rk:{id}:s:{n}, KEYS[2] = rk:{id}:s:{n}:ver, KEYS[3] = rk:{id}:s:{n}:ready
-- ARGV: member, composite, version
if redis.call('EXISTS', KEYS[3]) == 0 then return -1 end
local cur = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
local v = tonumber(ARGV[3])
if v <= cur then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], v)
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
return 1
```

SUM 랭킹은 증분 부호와 무관하게 항상 version 경로를 사용한다. 경로를 섞으면 version HASH가 갱신되지 않아 비교가 틀어진다.

**센티넬 조건이 필요한 이유:** 반영 재시도가 정산의 시즌 키 삭제보다 늦게 도착하면 지운 키가 멤버 몇 명으로 되살아나고, 아무도 지우지 않아 메모리에 남는다. API 인스턴스가 많을수록 확률이 커진다. 센티넬이 없으면 반영을 버리며, 정산은 MySQL 기준이므로 손실이 없다.

- 센티넬은 시즌이 OPEN될 때 스케줄러가 설정한다. 설정 전 반영은 버려지고 리컨실러가 따라잡는다.
- 재구축(6.3) 중에도 센티넬이 없으므로 라이브 키 반영은 버려지며, 재구축의 따라잡기 단계가 반영한다.

### 5.4 조회

| 패턴 | DESC | ASC |
| --- | --- | --- |
| 상위 페이징 | `ZRANGE key off off+size-1 REV WITHSCORES` | `ZRANGE key off off+size-1 WITHSCORES` |
| 내 순위 | `ZREVRANK key member WITHSCORE` | `ZRANK key member WITHSCORE` |

- 페이징과 내 순위를 파이프라인 하나로 처리한다.
- 순위 = 인덱스 + 1.
- 표시용 정보(닉네임 등)는 저장하지 않는다. 게임 서버가 조합한다.

### 5.5 영속화

- 기본값 RDB 스냅샷. 설정으로 끌 수 있다.
- AOF는 사용하지 않는다. MySQL이 원장이므로 영속화는 재시작 후 재구축 시간 단축 용도뿐이다.

### 5.6 시즌 키 삭제

가순위 생성(7.3)이 끝나면 해당 시즌 키를 삭제한다. **센티넬을 먼저 삭제**한 뒤 ZSET과 version HASH를 삭제한다. 지난 시즌 조회는 `ranking_entry`의 `final_rank`로 처리한다.

---

## 6. 정합성과 자가 복구

### 6.1 L1 즉시 재시도

Redis 반영 실패 시 짧은 백오프로 재시도한다.

- 첫 시도는 응답 전에 한다. 제출 직후 순위 조회에 새 값이 보이게 하기 위해서다.
- 실패하면 응답을 막지 않고 백그라운드에서 2회(100ms, 400ms 후) 다시 시도한다. 끝내 실패하면 L2가 따라잡는다.
- 명령마다 제한 시간(`REDIS_TIMEOUT_MS`, 기본 500ms)을 건다 (D-53).
- Redis 연결이 끊긴 동안은 시도하지 않는다. 요청마다 실패 로그를 남기는 대신 연결 상태가 바뀔 때만 남긴다.

### 6.2 L2 워터마크 차분 리컨실러

프로세스가 MySQL 커밋 직후 종료되면 실패 기록이 남지 않는다. 이를 MySQL 쪽 변경분 스캔으로 보완한다.

```text
매 N초 (OPEN 시즌 대상):
  1. updated_at > (checkpoint − 안전마진) 행을 PK 순 청크로 조회 (마스터)
  2. ranking_exclusion 대상 제외
  3. ZMSCORE로 Redis 현재 값 일괄 조회
  4. 계산한 composite와 다른 것만 반영 (5.3의 센티넬 확인 Lua)
  5. checkpoint 전진
```

- 안전마진은 최대 트랜잭션 시간보다 길게 잡는다 (30~60초). 구문 실행 시각과 커밋 시각의 차이를 흡수한다.
- 반드시 마스터에서 읽는다. 레플리카는 복제 지연으로 안전마진이 깨진다.
- checkpoint는 `job_state`에 두고, `GET_LOCK`으로 단일 실행을 보장한다.
- 같은 스캔에서 어뷰징 소프트 탐지(9.2)를 수행한다.
- 리컨실러도 라이브 키에 쓰므로 센티넬 확인 Lua를 사용한다. 그래야 정산의 키 삭제 후 키가 되살아나지 않는다. 예외는 재구축 따라잡기(6.3)로, 센티넬과 무관한 임시 키에 쓴다.

### 6.3 L3 전체 재구축

Redis 유실(퍼시스턴스 없는 재시작, 페일오버 데이터 손실) 대응.

```text
감지: OPEN 시즌인데 rk:{id}:s:{n}:ready 센티넬 없음
  1. 임시 키 rk:{id}:s:{n}:rebuild(및 :rebuild:ver)에 MySQL 파티션을 PK 청크로 적재 (제외 대상 건너뜀)
  2. 재구축 시작 시점의 워터마크부터 L2 방식으로 임시 키에 따라잡기
  3. RENAME으로 라이브 키에 원자적 교체 (ZSET, version HASH)
  4. 센티넬 설정
  5. 3~4 사이에 버려진 반영은 다음 L2 주기가 따라잡음
```

- 재구축 중 쓰기는 MySQL에 정상 적재되며 2단계와 이후 L2에서 반영된다.
- 정산이 끝나 키를 삭제한 시즌(SETTLING 이후)은 재구축 대상이 아니다.
- 재구축 중 조회는 "집계 중" 상태를 반환한다.

### 6.4 보조 점검

하루 1회 `ZCARD`와 MySQL `COUNT`를 비교한다. 불일치 시 L3를 트리거한다.

---

## 7. 정산

### 7.1 정산 시작 조건

```text
NOW ≥ settle_at (= end_at + settle_delay)
AND information_schema.INNODB_TRX에 trx_started < end_at 인 트랜잭션 없음
AND 리컨실러 워터마크 > end_at + 안전마진
```

`settle_delay`는 시각 검사를 통과해 이미 처리 중인 요청의 커밋을 기다리는 안전망이다. 조건 확인은 그 하한 위에서 실제 종료를 검증한다. (`INNODB_TRX` 조회는 `PROCESS` 권한 필요)

### 7.2 늦은 제출

기본은 **엄격 마감**이다. `end_at` 이후 제출은 전부 거부한다. 전투 중 시즌이 종료되는 경우 반영되지 않을 수 있음을 공지한다.

다음 시즌이 바로 열려 있는 경우(`wait_period = 0`)에도 제출의 시즌 번호 검사(4.1)로 이전 시즌 플레이가 다음 시즌에 반영되지 않는다.

### 7.3 SETTLING: 가순위 생성

`GET_LOCK('podium:settle')`으로 동시에 하나의 시즌만 처리한다. 시즌 파티션을 고정 이름 작업 테이블로 꺼내 가순위를 매긴 뒤 같은 파티션으로 되돌린다. 행을 복사하지 않는다 (D-49).

```text
1. ranking_entry.p_r{id}_s{n} ⇄ ranking_entry_settling   (EXCHANGE: 꺼내기, settling은 비어 있음)
2. ranking_entry_settling에 정렬용 인덱스 추가
3. final_rank 가순위를 커서 청크로 UPDATE                  (정적 SP)
4. ranking_entry_settling의 정렬용 인덱스 제거
5. ranking_entry_settling ⇄ ranking_entry.p_r{id}_s{n}   (EXCHANGE WITHOUT VALIDATION: 되돌리기)
6. Redis 시즌 키 삭제
7. REVIEW 전이, review_until = NOW + review_period
```

- 1·2단계와 4·5단계는 `SP_SETTLING_EXCHANGE` 하나가 맡는다. 호출마다 실제 상태를 보고(8.6) 다음 단계만 실행하고, 단계를 반환한다(1: OUT 가순위 진행 중, 2: RETURNED 되돌림 완료). 잡은 OUT이면 3단계를 이어서 한 뒤 다시 호출하고, RETURNED면 6단계로 간다.
- 정렬 인덱스는 운영 테이블에 두지 않는다. 스코어 제출마다 쓰기 비용이 늘기 때문이다. EXCHANGE는 인덱스까지 같아야 하므로 되돌리기 전에 제거한다.
- 정렬 인덱스는 `(ranking_id, season_no)` 뒤에 정렬 키를 둔다. 접두가 없으면 시즌 조건 때문에 옵티마이저가 PK 범위 조회 + filesort를 고를 수 있다.
- 동점 키는 `achieved_at`이 아니라 Redis composite(5.2)와 같은 시간 슬롯이다 (D-57). ms 그대로 비교하면 SEC 이상 랭킹에서 같은 슬롯 안의 동점자 순서가 Redis(`member_id` 순)와 달라져, 보이던 순위와 보상 순위가 어긋난다.
  `slot = FLOOR(TIMESTAMPDIFF(MICROSECOND, <시즌 start_at>, achieved_at) / <time_unit의 µs>)`
  시즌 시작 시각을 상수로 넣은 함수 키 인덱스라 시즌마다 식이 다르다. 가순위 UPDATE의 ORDER BY는 이 식과 글자까지 같아야 인덱스를 탄다.
- 3단계는 커서 기반 청크로 짧은 트랜잭션을 반복한다. 단일 대형 UPDATE는 언두 증가, 복제 지연, 버퍼 풀 오염을 일으킨다.
- 5단계: 기본 EXCHANGE는 일반 테이블의 모든 행이 파티션 값에 맞는지 읽어서 확인한다. 수백만 행을 읽는 동안 운영 테이블 DDL이 길어지므로, PK 범위 조회 두 번(`(ranking_id, season_no)`보다 앞·뒤 행 존재 여부)으로 다른 시즌 행이 없음을 먼저 확인하고 `WITHOUT VALIDATION`으로 교환한다.
- 5단계가 끝나면 settling은 비어 있으므로 다시 만들 필요가 없다.
- 제출은 `NOW(3) ∈ [start_at, end_at)` 검사(4.1)로 막히고 정산은 `settle_at` 이후에 시작하므로, 되돌린 파티션에 늦은 쓰기가 들어오지 않는다.

```sql
UPDATE ranking_entry_settling s
  JOIN (SELECT ranking_id, season_no, member_id,
               :base_rank + ROW_NUMBER() OVER (ORDER BY score DESC, slot ASC, member_id DESC) AS rn
          FROM (SELECT ranking_id, season_no, member_id, score, <slot 식> AS slot
                  FROM ranking_entry_settling
                 WHERE <커서 이후>
                 ORDER BY score DESC, <slot 식> ASC, member_id DESC
                 LIMIT 5000) c) t USING (ranking_id, season_no, member_id)
   SET s.final_rank = t.rn;
```

- `LIMIT`을 안쪽에 둔다. 윈도우 함수는 `LIMIT`보다 먼저 계산되므로, 같은 단계에 두면 청크마다 커서 이후 전체 행에 번호를 매겨 청크 수만큼 전체 정렬이 반복된다.
- 중단 후 재개 시 커서는 `MAX(final_rank)`인 행의 정렬 키, `:base_rank`는 그 값이다.

- 정렬 기준은 Redis 순서와 일치시킨다.
  - DESC: `score DESC, slot ASC, member_id DESC`
  - ASC: `score ASC, slot ASC, member_id ASC`
- 커서 조건은 정렬 방향이 섞여 있어 튜플 비교 대신 OR 조건으로 풀어 쓴다.

### 7.4 결과 컬럼

정산 결과는 별도 테이블 없이 `ranking_entry`의 결과 컬럼에 기록한다 (4.2, D-49).

| 컬럼 | 채우는 단계 |
| --- | --- |
| `final_rank` | SETTLING 가순위, FINALIZING 확정 (제재 제외 시 NULL) |
| `sanctioned` | FINALIZING, 지급 후 제재 |
| `reward_code`, `reward_status`, `reward_held` | FINALIZING 판정, 보류 건은 GM 전환 |
| `delivered_at` | DELIVERING ack |

- 결과 컬럼 갱신은 `version`, `updated_at`을 바꾸지 않는다. 두 컬럼은 스코어 값의 변경만 나타내며, 바꾸면 리컨실러가 변경분으로 잡는다.

| reward_status | 의미 |
| --- | --- |
| NONE | 미판정(진행 중) 또는 보상 구간 밖 |
| PENDING | 대상, 전달 전 |
| DELIVERED | 게임 서버 ack 완료 |
| REJECTED | 대상이었으나 제재로 미지급 |

`sanctioned`는 보상 상태와 별개의 표시용 플래그다.

### 7.5 REVIEW: 검수

- `review_until`이 지나면 자동으로 FINALIZING으로 진행한다. GM 승인을 기다리지 않는다.
- GM 조작:
  - **보류:** `review_hold = 1`. 해제 전까지 확정하지 않는다. 장기 보류 시 알림.
  - **조기 확정:** 기간을 기다리지 않고 진행.
- 검수 목록은 자동 생성한다: 보상 구간 내 유저 중 어뷰징 포인트 보유자, 하드 검증 위반 이력자.

### 7.6 FINALIZING: 확정

```text
1. ranking_exclusion 대상 → final_rank NULL, sanctioned = 1
2. 나머지 순위 재부여 (청크)
3. participant_count 기록, tier_snapshot 고정
4. reward_code 판정, reward_status 설정 (NONE / PENDING / REJECTED)
5. 보류 임계치 초과 유저 reward_held = 1
6. ranking_hall 적재 (상위 hall_size)
7. DELIVERING 전이
```

- 2단계는 `ix_final_rank`의 가순위 순서로 커서 청크를 돈다. 가순위 순서가 곧 정렬 순서이므로 정렬 인덱스가 필요 없다. 새 순위는 가순위보다 크지 않아서, 커서(이전 가순위) 이후 범위에 이미 처리한 행이 다시 나오지 않는다.
- 운영 테이블에서 처리하지만 끝난 시즌 파티션만 건드리며, 제출은 시각 검사로 이 파티션에 쓰지 않는다.

확정 이후 순위는 다시 매기지 않는다.

### 7.7 DELIVERING: 보상 전달

게임 서버가 페이지 단위로 가져가고 ack한다.

```text
1. GET  /v1/rankings/{id}/seasons/{n}/rewards?cursor=...   (PENDING, held 제외)
2. 게임 서버 우편 발송 — (ranking_id, season_no, member_id)를 지급 멱등 키로 사용
3. POST /v1/rankings/{id}/seasons/{n}/rewards/ack          → DELIVERED
```

- 정산 완료 웹훅은 "가져갈 목록이 생김" 신호로만 사용한다. 웹훅 유실에 대비해 게임 서버는 주기적으로 확인한다.
- 수령 기간은 랭킹 서버에 두지 않는다. 우편 만료는 게임 서버 정책이다.
- held 건은 GM 판단 후 PENDING 또는 REJECTED로 전환한다.
- PENDING(held 제외)이 모두 처리되면 SETTLED.
- 전달이 끝나지 않은 시즌은 기한 없이 운영 테이블에 보관한다. 게임 서버가 장애에서 복구되면 `GET /v1/rewards/pending`으로 밀린 시즌을 찾아 오래된 것부터 가져간다. 보상 API는 운영 테이블만 읽으므로(D-23), SETTLED 전에는 `ranking_entry` 시즌 파티션을 백업으로 분리하지 않는다 (8.2).

**알림 (연동 장애)**

| 조건 | 기준 |
| --- | --- |
| ack 정체 | DELIVERING 시즌의 PENDING이 설정 시간 동안 줄지 않음 |
| DELIVERING 적체 | DELIVERING 시즌 수가 설정 임계치 초과. 짧은 주기 랭킹은 장애 동안 시즌마다 `ranking_entry`, `ranking_submit_key` 파티션이 남아 테이블당 파티션 상한(8192)에 다가간다 |

두 기준은 설정값이다 (이름은 스케줄러 구현 시 정한다).

**강제 종료 (GM)**

- 게임 서버가 끝내 가져가지 않는 경우(연동 폐기, 보상 포기 결정)에만 GM이 DELIVERING 시즌을 SETTLED로 넘긴다. 자동으로는 실행하지 않는다.
- `ranking_season.forced_by`, `forced_reason`에 실행자와 사유를 기록한다.
- 남은 PENDING은 상태를 바꾸지 않은 채 이후 순서대로 백업 테이블로 분리된다. 백업 테이블에서 미전달 건을 확인할 수 있다.

**실패와 재시도**

- 게임 서버는 우편 발송에 성공한 건만 ack한다. ack를 먼저 보내면 발송 실패 시 보상이 유실된다.
- 목록 조회와 ack는 모두 재시도해도 안전하다. 게임 서버는 실패 시 백오프하며 재시도한다.
- ack는 멱등이다. `reward_status = PENDING`인 행만 DELIVERED로 바꾸고(조건부 갱신), 이미 DELIVERED인 행은 성공으로 본다. 그 외 상태(보류, REJECTED)라서 반영되지 않은 `member_id`는 응답에 따로 돌려준다.
- ack가 유실되면 해당 행은 다음 조회에 다시 나온다. 게임 서버는 지급 멱등 키 `(ranking_id, season_no, member_id)`로 중복 발송을 거른다.
- 목록은 `member_id` 오름차순 커서로 페이징한다. 한 페이지와 ack 한 번의 최대 건수는 같은 상한(예: 1,000)을 둔다. 대량 처리를 짧은 트랜잭션으로 나누기 위해서다.
- 웹훅 유실에 대비해 게임 서버는 전달 대기 시즌 목록(`GET /v1/rewards/pending`: DELIVERING 상태 (ranking_id, season_no)와 남은 건수)을 주기적으로 조회한다.

### 7.8 제재 처리

| 적발 시점 | 순위 | reward_status | 표시 |
| --- | --- | --- | --- |
| 시즌 중 | 실시간 순위에서 제거 (`ZREM`) | 정산 시 REJECTED | 노출 안 됨 |
| 검수 중 | 제외 후 재부여 | REJECTED | 순위 없음 |
| 지급 후 | 유지 (재부여 안 함) | DELIVERED 유지, 회수는 게임 서버 | `sanctioned = 1` |

```sql
CREATE TABLE `ranking_exclusion` (
    `ranking_id`    INT             UNSIGNED               NOT NULL        COMMENT '랭킹 ID (ranking_definition, FK 없음)',
    `season_no`     INT             UNSIGNED               NOT NULL        COMMENT '시즌 번호 (0:해당 랭킹 전 시즌, FK 없음)',
    `member_id`     VARCHAR(64)     COLLATE utf8mb4_bin    NOT NULL        COMMENT '멤버 ID (대소문자 구분)',
    `reason`        VARCHAR(255)                           NOT NULL        COMMENT '제재 사유',
    `created_by`    VARCHAR(64)                            NOT NULL        COMMENT '등록한 GM 식별자',
    `created_at`    DATETIME(3)                            NOT NULL        COMMENT '등록 시각 (UTC)',
    PRIMARY KEY (`ranking_id`, `season_no`, `member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='제재로 순위에서 제외할 멤버';
```

리컨실러와 재구축은 이 테이블을 확인해 제외 대상을 Redis에 다시 넣지 않는다.

---

## 8. 아카이브

### 8.1 EXCHANGE 원칙

- `EXCHANGE PARTITION`은 파티션 테이블의 파티션 1개 ↔ 비파티션 일반 테이블 1개 사이에서만 동작한다.
- 교환되는 것은 데이터 파일이며, 대상 테이블은 교환 후에도 일반 테이블이다.
- 목적은 운영 테이블에서 무거운 삭제를 빼내는 것이다. 데이터가 찬 파티션을 직접 DROP하면 운영 테이블에 배타 MDL이 걸린 채로 파일 삭제가 진행된다.
- 운영 테이블에서 일어나는 ADD / EXCHANGE / DROP은 모두 메타데이터 수준이다.

### 8.2 테이블별 생명주기

| 테이블 | 보관 대상 | 분리 시점 | 분리 방식 |
| --- | --- | --- | --- |
| `ranking_entry` | 진행 중 시즌, 확정 결과, 지난 시즌 조회 | 자기 시즌과 다음 시즌 모두 SETTLED (마지막 시즌은 자기 시즌 SETTLED) | EXCHANGE → 백업 |
| `ranking_submit_key` | 진행 + 정산 중 시즌 | SETTLED | EXCHANGE → 백업 |
| `ranking_hall` | 시즌별 Top N | 분리 없음 (영구) | — |

- 제출 이력(로그 DB `log_ranking_submit`)은 이 표의 대상이 아니다. 로그 DB에서 날짜 기준으로 따로 정리한다 (4.5).
- `ranking_entry`는 자기 시즌이 SETTLED가 아니면 분리하지 않는다. 보상 API는 운영 테이블만 읽으므로, 전달이 끝나지 않은 시즌을 분리하면 남은 PENDING을 조회할 수 없다 (7.7).
- 마지막 시즌은 다음 시즌 행이 없고, 랭킹이 반복 없음(NONE)이거나 종료(ENDED)되었거나 랭킹 `end_at`이 그 시즌 `end_at` 이하인 시즌이다. 다음 시즌이 생기지 않으므로 기다리지 않고 분리한다. 다음 시즌 행이 아직 생성되지 않았을 뿐인 반복 랭킹은 기다린다 (D-52).
- SETTLING에서 작업 테이블로 꺼냈다가 되돌리는 것(7.3)은 분리가 아니다. 파티션은 운영 테이블에 남는다.

백업 테이블 이름: `{원본}_r{rankingId}_s{seasonNo}`

```text
EXCHANGE 절차 (entry, submit_key)
1. CREATE TABLE {원본}_r{id}_s{n} LIKE {원본}
2. ALTER TABLE {원본}_r{id}_s{n} REMOVE PARTITIONING   (빈 테이블, 즉시)
3. ALTER TABLE {원본} EXCHANGE PARTITION p_r{id}_s{n} WITH TABLE {원본}_r{id}_s{n}
4. ALTER TABLE {원본} DROP PARTITION p_r{id}_s{n}       (빈 파티션, 즉시)
```

### 8.3 보관 방식

보관본은 파티션 히스토리 테이블이 아닌 **시즌별 일반 테이블**로 둔다.

- 시즌 단위로 독립 삭제, 덤프, 이동이 가능하다.
- 히스토리 스키마 변경이 과거 시즌 전체에 걸리지 않는다.
- 운영 테이블과의 스키마 동기화 부담이 없다.
- 테이블 수는 `history_retention`으로 상한을 두고, 설치 시 `table_open_cache`, `table_definition_cache`, `open_files_limit`를 그에 맞춰 설정한다.
- 보관 기간 경과 시 `DROP TABLE` 또는 덤프 후 삭제. 필요하면 별도 스키마로 `RENAME`.

### 8.4 ranking_hall

```sql
CREATE TABLE `ranking_hall` (
    `ranking_id`    INT            UNSIGNED               NOT NULL                 COMMENT '랭킹 ID (ranking_definition, FK 없음)',
    `season_no`     INT            UNSIGNED               NOT NULL                 COMMENT '시즌 번호',
    `final_rank`    INT            UNSIGNED               NOT NULL                 COMMENT '최종 순위',
    `member_id`     VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                 COMMENT '멤버 ID (대소문자 구분)',
    `score`         BIGINT         UNSIGNED               NOT NULL                 COMMENT '시즌 최종 스코어',
    `sanctioned`    TINYINT(1)                            NOT NULL    DEFAULT 0    COMMENT '제재 표시 (1:지급 후 제재됨, 0:없음)',
    PRIMARY KEY (`ranking_id`, `season_no`, `final_rank`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='시즌별 상위 순위 영구 보관';
```

- FINALIZING에서 제재 반영 후 상위 `hall_size`를 적재한다.
- 지급 후 제재 시 `sanctioned`를 함께 갱신한다.

### 8.5 조회 데이터 원천

| 조회 | 원천 |
| --- | --- |
| 현재 시즌 순위 | Redis |
| 직전 시즌 전체 순위, 내 순위 | `ranking_entry` (`final_rank`) |
| 모든 시즌 Top N | `ranking_hall` |
| 그 외 과거 기록 | 백업 테이블 (운영 조회 대상 아님) |

### 8.6 자가 복구 판단

```text
settling 비어 있음, entry 파티션에 final_rank NULL 행 있음 → 꺼내기 (EXCHANGE)
settling에 해당 시즌, final_rank NULL 행 있음              → 가순위 UPDATE 이어서 (MAX(final_rank) 기준, 정렬 인덱스 없으면 추가)
settling에 해당 시즌, final_rank NULL 행 없음              → 정렬 인덱스 제거 후 되돌리기 (EXCHANGE)
settling 비어 있음, entry 파티션에 final_rank NULL 행 없음  → SETTLING 완료
settling에 다른 시즌 행                                    → 멈춤, 알림 (1007)
되돌리기 직전 entry 파티션에 행 있음                        → 멈춤, 알림 (1008: 꺼낸 뒤 쓰기 발생)
```

작업 테이블의 `(ranking_id, season_no)` 컬럼으로 어느 시즌 데이터인지 확인한다. 이 판단은 시즌 상태가 SETTLING일 때만 쓴다. FINALIZING 이후에는 제재 제외 행의 `final_rank`가 NULL이다.

---

## 9. Anti-cheat

플레이의 정당성 검증은 게임 서버의 책임이다. 랭킹 서버는 도메인을 몰라도 판단 가능한 이상 징후만 다룬다.

### 9.1 하드 검증 (적재 시 거부)

| 검증 | 기준 |
| --- | --- |
| 범위 | `score_max` |
| 1회 최대 증분 | `max_delta` (SUM) |
| 제출 빈도 | `max_submit_per_min` (Redis 카운터, 1분 고정 창, 초과 시 2006) |
| 시즌 구간 | `[start_at, end_at)` |

거부 사유는 `ranking_submit_key.rejected`와 제출 이력(4.5)에 기록하고, 강한 의심 신호로 취급한다.

- 제출 빈도 초과는 SP 전에 거부하므로 멱등 키가 없고 제출 이력에만 `RATE_LIMIT`으로 남는다. 같은 `requestId`로 재시도하면 정상 처리된다.
- Redis 장애 시 빈도 검사는 통과시킨다. 원장 적재를 빈도 검사 때문에 막지 않는다.

### 9.2 소프트 탐지 (받되 표시)

- **속도:** 시간당 획득량이 임계치를 초과
- **순위 급등:** 짧은 시간에 큰 폭으로 순위 상승
- **BEST 급등:** 새 기록이 이전 최고의 N배 이상

리컨실러 스캔(6.2)에서 비동기로 수행한다. 오탐이 정상 유저를 해치지 않도록 거부하지 않는다.

### 9.3 어뷰징 포인트

```sql
CREATE TABLE `ranking_suspicion` (
    `suspicion_id`    BIGINT         UNSIGNED               NOT NULL    AUTO_INCREMENT    COMMENT '어뷰징 근거 ID',
    `ranking_id`      INT            UNSIGNED               NOT NULL                      COMMENT '랭킹 ID (ranking_definition, FK 없음)',
    `season_no`       INT            UNSIGNED               NOT NULL                      COMMENT '시즌 번호',
    `member_id`       VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                      COMMENT '멤버 ID (대소문자 구분)',
    `rule_code`       VARCHAR(32)    COLLATE utf8mb4_bin    NOT NULL                      COMMENT '탐지 규칙 코드 (suspicion_config의 키, 대소문자 구분)',
    `weight`          INT            UNSIGNED               NOT NULL                      COMMENT '가중치 (탐지 시점의 suspicion_config 값)',
    `evidence`        JSON                                  NOT NULL                      COMMENT '탐지 근거 (규칙별 수치)',
    `created_at`      DATETIME(3)                           NOT NULL                      COMMENT '탐지 시각 (UTC)',
    PRIMARY KEY (`suspicion_id`),
    KEY `ix_member_id` (`ranking_id`, `season_no`, `member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='어뷰징 포인트 근거';
```

- 포인트는 근거 행의 가중치 합으로 계산한다. 가중치는 `suspicion_config`에 둔다.
- 포인트는 판정이 아니라 지표다. 자동 조치는 보류 임계치 초과 시 해당 유저의 보상 보류(`reward_held`)까지만 한다.
- 시즌 단위로 누적한다. 검수 화면에 이전 시즌 포인트를 참고로 표시하되 합산하지 않는다.

---

## 10. 외부 API

### 10.1 인증

- `x-api-key` 헤더. 서버 간 호출 전용이며 클라이언트에 배포하지 않는다.
- TLS 필수. 가능하면 IP 허용 목록.
- 권한 분리: `write`(제출), `read`(조회), `reward`(보상 수신). 관리 API는 GM 도구 인증으로 분리한다.
- 복수 키 동시 활성 (무중단 교체). DB에는 해시만 저장한다.
- 키는 32바이트 난수(base64url 43자)이며 발급 시 한 번만 보여준다. 저장은 SHA-256 해시다. 엔트로피가 충분한 난수라 느린 해시(bcrypt 등)가 필요 없고, 요청마다 드는 비용을 피한다.
- API는 기동 시 활성 키 목록을 메모리에 올리고 30초마다 다시 읽는다. 요청마다 DB를 조회하지 않는다. 기동 시 읽기에 실패하면 기동을 거부하고, 재조회 실패 시 기존 목록을 유지하고 경고한다. 이전 재조회가 끝나지 않았으면(DB 정지 등) 이번 차례는 건너뛴다. 쿼리 타임아웃이 없어 겹쳐 쌓이면 풀 커넥션을 잡기 때문이다. 랭킹 정의 캐시(D-56)도 같다.
- 새 키는 발급 후 30초가 지나야 모든 인스턴스에서 통과한다. 교체는 발급 → 30초 대기 → 게임 서버 설정 변경 → 옛 키 폐기 순으로 한다.
- 유출 대응처럼 폐기를 즉시 반영해야 하면 폐기 후 API를 재시작한다. 재조회가 연속으로 실패하면(DB 장애 등) 폐기가 반영되지 않으므로 알린다.
- 발급과 폐기는 CLI(`npm run credential`)로 한다. 관리 API가 생기면 같은 SP를 쓴다.
- 로그에는 키 대신 `api_credential_id`를 남긴다.

```sql
CREATE TABLE `api_credential` (
    `api_credential_id`    INT            UNSIGNED    NOT NULL    AUTO_INCREMENT    COMMENT 'API 키 ID',
    `key_name`             VARCHAR(64)                NOT NULL                      COMMENT '키 이름 (용도 식별, 예: game-server-live)',
    `key_hash`             BINARY(32)                 NOT NULL                      COMMENT '키 SHA-256 해시',
    `scopes`               TINYINT        UNSIGNED    NOT NULL                      COMMENT '권한 비트 (1:WRITE 제출, 2:READ 조회, 4:REWARD 보상 수신) [codes.ApiScope]',
    `created_at`           DATETIME(3)                NOT NULL                      COMMENT '발급 시각 (UTC)',
    `revoked_at`           DATETIME(3)                            DEFAULT NULL      COMMENT '폐기 시각 (UTC, NULL:활성)',
    PRIMARY KEY (`api_credential_id`),
    UNIQUE KEY `ux_key_hash` (`key_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='서버 간 호출 API 키';
```

### 10.2 엔드포인트

| 메서드 | 경로 | 권한 | 설명 |
| --- | --- | --- | --- |
| POST | `/v1/rankings/{id}/scores` | write | 스코어 제출 (`memberId`, `value`, `seasonNo`, `requestId`, `meta?`. `sourceSeq`는 LATEST 전용으로 2차 범위) |
| GET | `/v1/rankings/{id}/top?offset&size` | read | 현재 시즌 상위 페이징 |
| GET | `/v1/rankings/{id}/members/{memberId}` | read | 현재 시즌 내 순위 |
| GET | `/v1/rankings/{id}/seasons/current` | read | 현재 시즌 정보 |
| GET | `/v1/rankings/{id}/seasons/{n}/results?offset&size` | read | 직전 시즌 결과 |
| GET | `/v1/rankings/{id}/seasons/{n}/results/{memberId}` | read | 직전 시즌 내 결과 |
| GET | `/v1/rankings/{id}/hall?season` | read | 시즌별 Top N |
| GET | `/v1/rankings/{id}/seasons/{n}/rewards?cursor` | reward | 전달 대상 목록 |
| POST | `/v1/rankings/{id}/seasons/{n}/rewards/ack` | reward | 전달 완료 (멱등, 7.7) |
| GET | `/v1/rewards/pending` | reward | 전달 대기 시즌 목록과 남은 건수 (웹훅 유실 대비 주기 확인) |

`sanctioned` 행은 플래그와 함께 반환한다. 표시 방식은 게임 서버가 정한다.

게임 서버는 `seasons/current`로 시즌 번호, 시작·종료 시각을 조회해 캐시하고 클라이언트 표시와 제출(`seasonNo`)에 사용한다. 시즌 경계(`end_at`)가 지나면 다시 조회한다.

### 10.3 응답과 결과 코드

- 성공은 HTTP 200과 `{ result: 0, data }`, 실패는 `{ result, message }`다. 비즈니스 실패를 200으로 보내지 않는다.
- SP 코드와 API 코드는 한 번호 공간이다(D-55). SP의 RESULT를 변환 없이 응답 `result`와 `log_ranking_submit.result_code`로 내보내, 대역만 보고 발생 위치를 안다. 이미 쓴 번호의 의미는 바꾸지 않는다.

| 대역 | 발생 위치 | HTTP |
| --- | --- | --- |
| 10xx | SP: 관리·공통 | 400 등 |
| 11xx | SP: 제출 | 400·404·409 등 (코드별) |
| 12xx | SP: API 키 | (CLI 전용) |
| 20xx | API 계층: 2001 요청 형식, 2002 인증, 2003 권한, 2004 경로 없음, 2005 시간 초과, 2006 제출 빈도 초과 | 400, 401, 403, 404, 503, 429 |
| 5000 | 앱 미분류 예외 | 500 |
| 50001 | DB 시스템 오류 (SP EXIT HANDLER) | 500 |

- 도메인당 99개다. 넘치면 예비 대역을 준다.
- 코드별 메시지와 HTTP 상태는 `src/errors.ts`의 `ERROR_MAP`에서만 관리하고, Swagger 문서의 결과 코드 표도 여기서 만든다.
- 응답 헤더 `x-request-id`는 그 요청의 로그 두 줄(요청/응답)을 짝짓는 ID다. 문의 시 이 값을 받는다.
- 처리 제한 시간(`API_TIMEOUT_MS`, 기본 30초)을 넘으면 2005를 응답하지만 진행 중인 SP는 취소되지 않아 반영될 수 있다. 제출은 같은 `requestId`로 재시도한다.
- Swagger UI(`/docs`)는 `API_DOCS=1`일 때만 연다.

---

## 11. 운영 원칙

### 11.1 MDL 대응

`ranking_entry`는 여러 랭킹이 공유하므로, DDL이 배타 MDL 대기 중이면 뒤의 모든 랭킹 쓰기가 막힌다.

- DDL 세션은 `lock_wait_timeout`을 짧게(예: 2초) 설정하고, 실패 시 재시도한다.
- 운영 테이블에 긴 쿼리를 금지한다. 리컨실러는 작은 청크, GM·통계 조회는 레플리카에서 실행한다.
- 아카이브 DDL은 랭킹 정의의 한가한 시간대에 몰아서 실행할 수 있다.
- 마이그레이션에 운영 테이블 대량 데이터 변경(backfill)을 넣지 않는다. 필요하면 청크 단위 별도 잡으로 실행한다.
- 운영 테이블 스키마 변경은 `ALGORITHM=INSTANT`로 처리되는 것을 우선한다. 그렇지 않은 변경(인덱스 추가, 타입 변경 등)은 소요 시간을 측정해 점검 시간 안에 끝나는지 확인한다.

### 11.2 동적 SQL 제한

- 모든 DB 로직은 SP로 작성한다. SP 이름은 개발 컨벤션의 대문자 표기를 따른다.
- MySQL은 DDL 식별자에 변수를 받지 않으므로 파티션 DDL에는 동적 SQL이 불가피하다.
- `PREPARE`를 사용하는 SP는 **`SP_EXEC_DDL` 하나**로 한정한다. 로그 DB도 자기 `SP_EXEC_DDL` 하나만 둔다 (DB마다 하나, D-48).

| SP | 역할 | 호출 |
| --- | --- | --- |
| `SP_EXEC_DDL(sql)` | 유일한 PREPARE 실행 지점, 감사 로그 기록. `SQL SECURITY INVOKER` (D-51) | 관리 SP 내부 |
| `SP_PARTITION_ADD(rid, sno)` | 두 파티션 테이블(entry, submit_key)에 시즌 파티션 추가. 이미 있으면 건너뜀 | 앱 |
| `SP_SETTLING_EXCHANGE(rid, sno)` | SETTLING의 DDL 단계를 상태를 보고 진행: 꺼내기와 정렬 인덱스 추가, 또는 인덱스 제거와 `WITHOUT VALIDATION` 되돌리기. 단계 반환 (7.3, 8.6) | 앱 |
| `SP_PARTITION_EXCHANGE(code, rid, sno)` | 분리 조건(8.2)을 다시 확인한 뒤 백업 테이블 생성 후 교환. 파티션이 비어 있으면 교환하지 않음 (재실행 시 되돌아감 방지) | 앱 |
| `SP_PARTITION_DROP(code, rid, sno)` | 파티션이 비어 있고 시즌이 SETTLED(또는 시즌 행 없음)일 때만 삭제 | 앱 |
| `SP_LOG_PARTITION_ADD(day)` | 로그 DB. `log_ranking_submit` 일 파티션을 `day`까지 생성 (호출당 최대 64일) | 앱 |
| `SP_LOG_PARTITION_DROP(day)` | 로그 DB. `day` 이전 일 파티션 삭제 (호출당 최대 31개) | 앱 |

- 대상 코드(`code`, TINYINT): 1 = `ranking_entry`, 2 = `ranking_submit_key`
- SP의 RESULT 코드는 `src/codes.ts`의 `SpResult`이며 API 응답 코드로 그대로 나간다(10.3). 관리 SP는 1001~1008, `SP_SUBMIT_SCORE`는 1101~1107(4.1의 결과 표, 하드 검증 거부는 사유별 1105~1107), API 키 SP는 1201~1202다. 1007, 1008은 사람이 확인해야 하는 상태라 알린다.
- 관리 SP는 상태를 관측해 다음 단계만 실행하므로 같은 인자로 다시 호출해도 안전하다.
- 관리 SP는 `ranking_id`, `season_no`를 `INT UNSIGNED`로, 대상은 코드로만 받아 이름을 조립한다.
- 데이터 경로 SP(제출, 조회, 결과 적재, 보상)는 전부 정적 SQL이다.

**오류 처리**

| 구분 | 방식 |
| --- | --- |
| `SP_EXEC_DDL` (내부 헬퍼) | 실행 전 감사 로그 행 기록 → 실행 → 결과 갱신. 실패 시 `DEALLOCATE`, 감사 로그에 오류 기록 후 `RESIGNAL` |
| 앱이 호출하는 SP | 컨벤션 RESULT 규약. 관리 SP는 헬퍼의 예외를 받아 `50001`로 반환 |

헬퍼가 RESULT를 SELECT하면 호출한 SP에서 결과셋이 이중으로 나가므로, 헬퍼는 예외로만 실패를 알린다. DDL은 암묵적으로 커밋되므로 감사 로그는 실행 전에 먼저 기록한다.

`RESULT 0`을 보낸 뒤 데이터 SELECT가 실패하면 EXIT HANDLER의 50001이 두 번째 결과셋으로 나간다. 데이터 결과셋에는 `RESULT` 컬럼이 없으므로, 앱(`callSp`)은 두 번째 결과셋 첫 행의 `RESULT = 50001`도 DB 오류로 처리한다. 오류 행을 데이터로 쓰면 조용히 틀리기 때문이다.

### 11.3 잡 실행

- 모든 잡은 실제 상태를 관측해 다음 단계를 판단하고 멱등하게 실행한다.
- `GET_LOCK`으로 잡별 단일 실행을 보장한다. 워커가 여러 대여도 잡은 한 곳에서만 돈다. 워커 스케일아웃은 처리량이 아니라 가용성(한 대가 죽어도 이어받음)을 위한 것이다.
- `GET_LOCK`은 커넥션에 묶이므로, 락 헬퍼는 풀에서 **전용 커넥션**을 받아 작업이 끝날 때까지 반납하지 않는다. 헬퍼는 획득 → 작업 → `RELEASE_LOCK` → 반납을 보장한다.
- 락 헬퍼는 SP를 거치지 않고 `GET_LOCK`을 직접 호출한다. 러너가 SP 생성 전에도 사용해야 하기 때문이며, 컨벤션(DB 접근은 SP)의 예외다.
- 커넥션이 끊기거나 MySQL이 페일오버되면 락이 풀려 다른 워커가 같은 잡을 시작할 수 있다. 장시간 잡은 청크마다 `IS_USED_LOCK(name) = CONNECTION_ID()`로 보유를 확인하고, 아니면 즉시 중단한다.
- 파괴적 작업(DROP) 직전 건수를 검증하고, 불일치 시 실행하지 않는다.
- 다음 시즌 파티션은 여러 주기 앞서 생성한다.
- 재시도로 해결되지 않으면 알림을 보낸다.

### 11.4 운영 테이블

| 테이블 | 용도 |
| --- | --- |
| `log_ddl_audit` | `SP_EXEC_DDL` 실행 SQL, 시작·종료 시각, 오류 정보 |
| `job_state` | 잡별 워터마크(리컨실러 checkpoint 등), 마지막 실행 시각 |
| `instance_heartbeat` | 실행 중인 API·워커 인스턴스 (`instance_id`, `process_type`, `app_version`, `last_seen_at`) |

- 인스턴스는 기동 후 주기적으로(예: 10초) 하트비트를 갱신하고(`SP_UPSERT_INSTANCE_HEARTBEAT`), 정상 종료 시 자기 행을 삭제한다(`SP_DELETE_INSTANCE_HEARTBEAT`). 최근 30초 안의 하트비트를 살아 있는 인스턴스로 본다.
  30초는 주기의 3배다. 한두 번의 누락(네트워크 지연 등)은 살아 있는 것으로 본다.
- `last_seen_at`은 SP가 DB 시각(`NOW(3)`)으로 기록하고 migrate도 DB 시각으로 비교한다. 호스트마다 시계가 달라도 판정이 틀어지지 않는다.
- 첫 하트비트 기록이 실패하면 기동하지 않는다. 하트비트 없이 뜬 인스턴스는 migrate 검사에 보이지 않아, 중지 없이 migrate가 실행될 수 있기 때문이다.
- 정상 종료 순서는 처리 중단(요청 수신 중지, 진행 중 요청 마무리, 재조회 정지, Redis 연결 종료, 진행 중 제출 이력 적재 대기 후 로그 DB 풀 종료) → 하트비트 삭제 → 메인 DB 풀 → 로거다. 처리가 멈춘 뒤에 지워야 migrate가 아직 일하는 인스턴스를 놓치지 않는다. 종료 신호가 겹치거나 처리 중단이 실패해도 하트비트 삭제는 반드시 실행한다.
- `instance_id`는 프로세스 기동마다 생성하는 UUID다. PID는 재사용되어 다른 인스턴스의 행을 덮어쓸 수 있다.
- 비정상 종료로 남은 행은 하트비트 루프가 `last_seen_at`이 1시간 넘게 지난 행을 함께 삭제해 정리한다.

운영 테이블은 `podium_de` DB에 둔다. `log_ddl_audit`는 `SP_EXEC_DDL` 안에서 기록해야 하기 때문이다. 제출 이력은 로그 DB `podium_de_log`에 둔다 (4.5).

**보관 정리 감시**

정리 잡이 조용히 멈추면 결국 디스크가 찬다. 사람이 알아채는 데 의존하지 않고 알린다.

| 조건 | 대상 |
| --- | --- |
| `history_retention`보다 오래된 백업 테이블이 존재 | 메인 DB 시즌 백업 테이블 |
| 정리 잡 마지막 성공(`job_state.last_run_at`)이 설정 시간보다 오래됨 | 백업 정리, 로그 정리 |
| `p_max`에 행이 있음 | 로그 DB 일 파티션 생성 실패 |
| 로그 DB 기록 실패율이 임계치 초과 | 제출 이력 |

- 디스크 사용률 알림은 설치 환경(인프라 모니터링)에 둔다.

```sql
CREATE TABLE `log_ddl_audit` (
    `log_ddl_audit_id`    BIGINT          UNSIGNED    NOT NULL    AUTO_INCREMENT    COMMENT '감사 로그 ID',
    `sql_text`            TEXT                        NOT NULL                      COMMENT '실행한 DDL',
    `status`              TINYINT         UNSIGNED    NOT NULL                      COMMENT '상태 (0:RUNNING 실행 중 또는 중단, 1:SUCCEEDED 성공, 2:FAILED 실패) [codes.DdlAuditStatus]',
    `started_at`          DATETIME(3)                 NOT NULL                      COMMENT '실행 시작 시각 (UTC)',
    `finished_at`         DATETIME(3)                             DEFAULT NULL      COMMENT '실행 종료 시각 (UTC, NULL:실행 중 또는 중단)',
    `sql_state`           CHAR(5)                                 DEFAULT NULL      COMMENT '실패 시 SQLSTATE',
    `error_no`            INT             UNSIGNED                DEFAULT NULL      COMMENT '실패 시 MySQL 에러 번호',
    `error_message`       VARCHAR(512)                            DEFAULT NULL      COMMENT '실패 시 에러 메시지',
    PRIMARY KEY (`log_ddl_audit_id`),
    KEY `ix_started_at` (`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='SP_EXEC_DDL 실행 감사 로그';
```

- 실행 전에 `status = 0`으로 행을 기록하고, 실행 후 성공(1) 또는 실패(2)와 오류 정보를 갱신한다. `status = 0`으로 남은 행은 실행 중 중단된 것이다.

```sql
CREATE TABLE `job_state` (
    `job_name`       VARCHAR(64)                NOT NULL                    COMMENT '잡 이름 (예: reconciler)',
    `ranking_id`     INT            UNSIGNED    NOT NULL                    COMMENT '대상 랭킹 ID (0:랭킹 무관, FK 없음)',
    `season_no`      INT            UNSIGNED    NOT NULL                    COMMENT '대상 시즌 번호 (0:시즌 무관, FK 없음)',
    `watermark`      DATETIME(3)                            DEFAULT NULL    COMMENT '처리 완료 워터마크 (UTC, 리컨실러는 updated_at checkpoint)',
    `last_run_at`    DATETIME(3)                            DEFAULT NULL    COMMENT '마지막 실행 시각 (UTC)',
    `updated_at`     DATETIME(3)                NOT NULL                    COMMENT '행 갱신 시각 (UTC)',
    PRIMARY KEY (`job_name`, `ranking_id`, `season_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='워커 잡별 진행 상태';
```

- 리컨실러 워터마크는 정산 시작 조건(7.1)에서 시즌별로 비교하므로 키에 `(ranking_id, season_no)`를 둔다. 랭킹과 무관한 잡은 `(0, 0)`을 쓴다.

```sql
CREATE TABLE `instance_heartbeat` (
    `instance_id`     CHAR(36)       CHARACTER SET ascii COLLATE ascii_bin    NOT NULL        COMMENT '인스턴스 ID (기동마다 생성하는 UUID)',
    `process_type`    TINYINT        UNSIGNED                                 NOT NULL        COMMENT '프로세스 유형 (1:API, 2:WORKER 워커) [codes.ProcessType]',
    `app_version`     VARCHAR(32)                                             NOT NULL        COMMENT '실행 중인 패키지 버전 (package.json version)',
    `last_seen_at`    DATETIME(3)                                             NOT NULL        COMMENT '마지막 하트비트 시각 (UTC, DB 시각)',
    PRIMARY KEY (`instance_id`),
    KEY `ix_last_seen_at` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='실행 중인 API·워커 인스턴스 하트비트';
```

### 11.5 마이그레이션

- **테이블:** 버전 마이그레이션. 버전 테이블과 체크섬으로 관리한다. 적용 후 내용이 바뀐 버전 파일은 오류로 처리한다. 파일 하나에는 DDL 구문 하나만 둔다 (DDL은 암묵적 커밋이라 여러 구문이면 일부만 적용된 채 남을 수 있다).
- **SP:** 반복 마이그레이션. 체크섬이 바뀌면 DROP 후 CREATE한다.
- 통합 SQL 파일은 두지 않는다. 같은 내용을 두 곳에서 관리하지 않기 위해서다.
- 상태·구분값은 ENUM 대신 `TINYINT UNSIGNED` 코드로 저장한다. 값의 의미는 `src/codes.ts`의 const에서만 관리하고, 컬럼 COMMENT에 코드→의미 매핑과 const 이름을 함께 적는다 (D-46). 이 문서 본문의 상태 이름(OPEN, PENDING 등)은 해당 const 키를 가리킨다.
- 이 문서의 DDL은 `database/tables/`의 최종 스키마와 같게 유지한다. 테이블 변경 마이그레이션을 추가하면 해당 절의 DDL도 함께 고친다. 테이블 추가나 관계 변경은 [04_SCHEMA](04_SCHEMA.md)의 목록과 ERD에도 반영한다.
- **적용은 `npm run migrate`로만 한다.** API와 워커는 기동 시 적용하지 않고 확인만 한다.
- **DB별 디렉터리:** 메인은 `database/{tables,procedures}`, 로그 DB는 `database_log/{tables,procedures}`. 각 DB에 자기 `schema_migration`을 둔다.
- `npm run migrate`는 `podium:migrate` 락(메인 DB) 하나 안에서 메인 → 로그 DB 순으로 적용한다. 하트비트 검사는 메인 DB에서 한 번, 역행 검사는 DB마다 한다.
- 기동 시 확인: 메인 불일치는 기동 거부. 로그 DB는 접속되면 확인해 불일치 시 기동 거부, 접속 불가면 경고 후 기동(로그는 유실 허용).
- 로그 DB 접속 정보와 계정은 메인과 별도이며 필수다. 비었을 때 메인 값으로 대체하지 않는다 (D-48).
- `SP_EXEC_DDL`은 DB마다 하나다. 로그 DB의 파티션 이름은 `DATE` 파라미터로만 조립한다.
- 컨벤션과 설계가 충돌하면 컬럼·키 구조는 설계를, 표기 규칙(COMMENT, 헤더 주석, charset/collation, 인덱스 이름)과 SP 이름은 컨벤션을 따른다.
- 로그성 테이블(쌓기만 하는 이력·감사 기록)은 `log_` 접두어를 붙인다: `log_ranking_submit`, `log_ddl_audit`. 멱등 키(`ranking_submit_key`)처럼 처리에 쓰는 테이블은 해당하지 않는다.
- 식별자 컬럼(`member_id`, `request_id`, `ranking_code`, `reward_code`, `rule_code`)은 `utf8mb4_bin`이다. 대소문자를 구분하지 않으면 다른 식별자가 하나로 합쳐진다.

**기동 시 확인**

```text
하트비트 기록 → GET_LOCK('podium:migrate') → 스키마 확인 → RELEASE_LOCK
확인 실패 시 하트비트 행 삭제 후 종료
```

- 기동은 migrate 락을 **최대 10초** 기다리며, 못 잡으면 기동에 실패한다. 실패 메시지는 migrate 실행 중인지 확인하도록 안내한다. 중단 패치 절차를 따르면 발생하지 않는다.

- 스키마 확인은 버전 번호가 아니라 패키지의 SQL 파일 목록·체크섬과 DB 적용 기록을 통째로 비교한다.
- 적용 기록은 `SP_GET_SCHEMA_STATE`로 읽는다(RESULT 0 + `script_name`, `checksum` 행). 앱 계정은 테이블에 직접 접근할 수 없기 때문이다. 이 SP가 없으면(errno 1305) migrate가 필요하다고 안내하고 기동을 거부한다.
- **하트비트 기록이 락 획득보다 먼저**여야 한다. 기동이 락을 먼저 잡으면 이후 migrate가 하트비트를 보고 거부하고, migrate가 먼저 잡으면 기동은 적용 완료 후 스키마 불일치로 거부된다. 순서가 바뀌면 "migrate의 하트비트 검사 직후 구버전 기동"을 막지 못한다.

**migrate 거부 조건**

```text
GET_LOCK('podium:migrate') → 하트비트 검사 → 역행 검사 → 적용 → RELEASE_LOCK
```

- 살아 있는 인스턴스 하트비트가 있음 (중지 없이 실행 방지). 강제 실행 옵션은 두지 않는다.
- DB에 적용 기록이 있는 테이블 버전 파일이 현재 패키지에 없음 (테이블 변경이 포함된 롤백 실수를 자동 차단)
- DB에 기록된 `package.json` version보다 낮은 패키지 (SP만 바뀐 롤백 실수 차단)
- 러너 세션의 `lock_wait_timeout`은 짧게(2초) 잡고 재시도한다.

**규칙: DB 변경이 있는 배포는 `package.json` version을 올린다.** SP만 바뀐 경우 파일 목록으로는 신구를 판단할 수 없어 version 비교에 의존한다. 올리지 않으면 역행 검사가 같은 버전으로 보고 통과시킨다.

| 실수 | 차단 |
| --- | --- |
| 인스턴스를 내리지 않고 migrate | 하트비트 검사 |
| migrate 없이 새 버전 기동 | 기동 시 스키마 확인 |
| migrate 하트비트 검사 직후 구버전 기동 | 기동·migrate 락 공유 + 하트비트 선기록 |
| 구버전 패키지로 migrate (테이블 변경 포함) | 미지의 테이블 버전 검사 |
| 구버전 패키지로 migrate (SP만 변경) | package version 역행 검사 |

### 11.6 배포

| 배포 유형 | 방식 |
| --- | --- |
| DB 변경 없음 (앱 코드만) | 롤링 무중단 |
| DB 변경 있음 (테이블, SP) | 중단 패치: 전체 중지 → migrate → 기동 |

**DB 변경 패키지를 실수로 롤링했을 때**

| 보장 | 성립 조건 |
| --- | --- |
| 데이터 안전 (틀린 스키마로 서비스하지 않음) | 항상. 기동 시 스키마 확인이 도구와 무관하게 기동을 거부한다 |
| 가용성 (구버전이 계속 서비스) | 실패한 배포를 **멈추는** 롤링 도구일 때만. 예: Kubernetes RollingUpdate는 새 Pod가 Ready가 되지 않으면 진행을 멈춘다 (미검증) |

- **pm2는 가용성을 보장하지 않는다 (실험 확인).**
  - `pm2 reload --wait-ready`는 새 프로세스가 ready를 보내지 않아도 `listen_timeout`이 지나면 구버전을 내린다. 기다리기만 할 뿐 멈추지 않으며, 실험에서 약 32초 뒤 전체 중단되었다.
  - fork 모드에서는 reload가 재시작으로 동작해 구버전이 바로 내려간다.
  - 따라서 **DB 변경 패키지에는 pm2 reload를 금지하고 `upgrade`만 사용한다.** pm2 reload는 DB 변경이 없는 패키지에만 쓴다.
- 실패한 배포를 멈추지 않는 롤링 방식은 DB 변경 여부를 확인한 뒤에만 사용한다.
- **준비 신호:** API와 워커는 기동 확인을 통과한 뒤(API는 listen 성공 후) `process.send('ready')`를 보낸다. API는 `GET /health`로 기동 확인 통과 여부를 반환한다. pm2는 `--wait-ready`, 로드밸런서·오케스트레이터는 `/health`를 사용한다.

- DB 변경이 있는 배포는 **게임 점검 시간**에 맞추는 것을 원칙으로 한다. 게임이 내려가 있으면 스코어 제출이 없으므로 랭킹 서버 중지의 영향이 없다.
- 중단 중에도 시즌 마감은 시각으로 정해지고, 정산·아카이브는 상태 관측 기반이므로 기동 후 밀린 단계부터 이어서 처리한다.
- 랭킹 서버만 단독으로 중단하는 경우, 게임 서버는 제출을 보관했다가 같은 `requestId`, `seasonNo`로 재시도한다. 그사이 시즌이 끝났으면 `SEASON_MISMATCH`로 정리된다.

**upgrade 스크립트 (`npm run upgrade`)**

```text
1. UPGRADE_STOP_CMD 실행
2. 살아 있는 하트비트가 없어질 때까지 대기 (타임아웃 시 남은 인스턴스 출력 후 중단)
3. migrate
4. UPGRADE_START_CMD 실행
5. 기대 구성(API 수, 워커 수)만큼 새 app_version 하트비트 확인 (타임아웃 시 실패, 종료 코드 1)
```

- 프로세스 중지·기동 명령은 환경(pm2, systemd, Docker 등)마다 다르므로 환경 변수로 주입한다. 스크립트는 환경과 무관하다.
- 명령 미설정 시 1단계 전에 중단하고 설정 방법을 안내한다.

## 12. 구현 범위와 순서

### 12.1 1차 범위

- 갱신 규칙: BEST, SUM
- 랭킹 유형: 시즌, 이벤트, 영구
- 정산 전 과정, 보상 일괄 전달, 제재 처리, hall
- 하드 검증, 소프트 탐지(속도, 순위 급등), 어뷰징 포인트
- 자가 복구 L1~L3

### 12.2 2차 이후

- LATEST
- 늦은 제출 허용 (`late_submit_grace`)
- 2차 정렬 기준 (달성 시각 외)
- 친구·길드 랭킹 조회
- 분포 기반 이상치 탐지, 섀도 보드
- 탈퇴 유저 가명화

### 12.3 구현 순서

1. 스키마, 파티션 관리 SP, 스코어 적재 SP
2. API 인증, 제출 API, Redis 반영, 순위 조회 → 부하 테스트
3. 자가 복구 (리컨실러, 센티넬, 재구축)
4. 시즌 스케줄러 (생성, 상태 전이, 정산, 전달)
5. 아카이브 로테이션
6. Anti-cheat, 운영 도구, 설치 패키징
