-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_season
-- 작성 : 2026.10.02 trisakion
-- 내용 : 랭킹별 시즌 (01_DESIGN 3.1). 스케줄러가 랭킹 정의로 자동 생성한다(INSERT IGNORE로 멱등).
--        쓰기 차단은 status가 아니라 [start_at, end_at) 시각 검사로 한다 (01_DESIGN 3.5).
--        forced_by, forced_reason은 DELIVERING 시즌을 GM이 강제 종료할 때만 채운다 (01_DESIGN 7.7, D-47).
--        의도적 복합 PK (ranking_id, season_no): 시즌 파티션 키와 같은 자연키다 (D-35).
--        ranking_id는 FK 없음: 키 구조는 설계를 따르며, 설계에 FK가 없다 (D-35).
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `ranking_season` (
    `ranking_id`           INT             UNSIGNED    NOT NULL                    COMMENT '랭킹 ID (ranking_def, FK 없음)',
    `season_no`            INT             UNSIGNED    NOT NULL                    COMMENT '시즌 번호 (랭킹 안에서 1부터)',
    `start_at`             DATETIME(3)                 NOT NULL                    COMMENT '시즌 시작 시각 (UTC, 포함)',
    `end_at`               DATETIME(3)                 NOT NULL                    COMMENT '시즌 종료 시각 (UTC, 미포함)',
    `settle_at`            DATETIME(3)                 NOT NULL                    COMMENT '정산 시작 하한 시각 (UTC, end_at + settle_delay)',
    `review_until`         DATETIME(3)                             DEFAULT NULL    COMMENT '검수 종료 시각 (UTC, 정산 결과 생성 후 확정)',
    `status`               TINYINT         UNSIGNED    NOT NULL                    COMMENT '상태, 진행 순서대로 증가 (1:SCHEDULED 예정, 2:OPEN 적재, 3:CLOSED 적재 차단, 4:SETTLING entry 분리·가순위, 5:REVIEW 검수, 6:FINALIZING 확정, 7:DELIVERING 보상 전달, 8:SETTLED 완료) [codes.SeasonStatus]',
    `review_hold`          TINYINT(1)                  NOT NULL    DEFAULT 0       COMMENT '검수 보류 (1:보류 — 해제 전까지 확정하지 않음, 0:없음)',
    `participant_count`    INT             UNSIGNED                DEFAULT NULL    COMMENT '제재 제외 후 확정 참가자 수 (FINALIZING에서 기록)',
    `tier_snapshot`        JSON                                    DEFAULT NULL    COMMENT '정산 시 적용된 보상 구간 스냅샷',
    `settled_at`           DATETIME(3)                             DEFAULT NULL    COMMENT '정산 완료(SETTLED) 시각 (UTC)',
    `forced_by`            VARCHAR(64)                             DEFAULT NULL    COMMENT 'DELIVERING 강제 종료한 GM 식별자 (NULL:정상 종료) — 남은 PENDING은 그대로 백업으로 분리됨',
    `forced_reason`        VARCHAR(255)                            DEFAULT NULL    COMMENT 'DELIVERING 강제 종료 사유',
    PRIMARY KEY (`ranking_id`, `season_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='랭킹별 시즌';
