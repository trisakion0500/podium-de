-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_suspicion
-- 작성 : 2026.10.02 trisakion
-- 내용 : 어뷰징 포인트 근거 (01_DESIGN 9.3). 포인트는 근거 행의 weight 합이며 판정이 아니라 지표다.
--        리컨실러 스캔의 소프트 탐지(01_DESIGN 9.2)가 INSERT한다. 시즌 단위로 누적한다.
--        ranking_id는 FK 없음: 키 구조는 설계를 따르며, 설계에 FK가 없다 (D-35). member_id, rule_code는 대소문자를 구분한다.
-- ------------------------------------------------------------------------------------------------------------ --
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
