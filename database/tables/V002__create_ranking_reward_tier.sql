-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_reward_tier
-- 작성 : 2026.10.02 trisakion
-- 내용 : 랭킹별 보상 구간 (01_DESIGN 2.6). 정산 시점의 구간은 ranking_season.tier_snapshot에 고정한다.
--        의도적 복합 PK (ranking_id, tier_no): 랭킹 안의 구간 번호가 자연키다 (D-35, 키 구조는 설계를 따름).
--        ranking_id는 FK 없음: 키 구조는 설계를 따르며, 설계에 FK가 없다 (D-35).
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `ranking_reward_tier` (
    `ranking_id`     INT            UNSIGNED               NOT NULL        COMMENT '랭킹 ID (ranking_def, FK 없음)',
    `tier_no`        SMALLINT       UNSIGNED               NOT NULL        COMMENT '구간 번호 (랭킹 안에서 유일)',
    `range_type`     TINYINT        UNSIGNED               NOT NULL        COMMENT '구간 기준 (1:RANK 순위, 2:PERCENT 제재 제외 참가자 수 대비 백분율) [codes.RangeType]',
    `range_from`     INT            UNSIGNED               NOT NULL        COMMENT '구간 시작 (포함)',
    `range_to`       INT            UNSIGNED               NOT NULL        COMMENT '구간 끝 (포함)',
    `reward_code`    VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL        COMMENT '보상 코드 (게임 서버가 해석, 대소문자 구분)',
    PRIMARY KEY (`ranking_id`, `tier_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='랭킹별 보상 구간';
