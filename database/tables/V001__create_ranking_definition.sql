-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_definition
-- 작성 : 2026.10.02 trisakion
-- 수정 : 2026.10.04 trisakion 테이블명 변경 (D-50)
-- 내용 : 랭킹 정의 (01_DESIGN 2.1). 관리자가 등록하며 순위 규칙(update_rule~time_bits)은 등록 후 불변이다.
--        ranking_id는 1부터 쓴다. (0, 0)은 파티션 테이블의 초기 파티션 p_init 값이다 (01_DESIGN 4.2).
--        ranking_code는 식별자라 utf8mb4_bin으로 대소문자를 구분한다 (D-35).
-- ------------------------------------------------------------------------------------------------------------ --
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
