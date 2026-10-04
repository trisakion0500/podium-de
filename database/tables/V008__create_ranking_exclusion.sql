-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_exclusion
-- 작성 : 2026.10.02 trisakion
-- 내용 : 제재로 순위에서 제외할 멤버 (01_DESIGN 7.8). 리컨실러·재구축은 이 테이블을 보고 Redis에 다시 넣지 않는다.
--        season_no = 0은 해당 랭킹 전 시즌 제외를 뜻하는 sentinel이다.
--        의도적 복합 PK (ranking_id, season_no, member_id): 제외 대상의 자연키다 (D-35).
--        ranking_id, season_no는 FK 없음: season_no 0 sentinel이 있고, 키 구조는 설계를 따른다 (D-35).
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `ranking_exclusion` (
    `ranking_id`    INT             UNSIGNED               NOT NULL        COMMENT '랭킹 ID (ranking_definition, FK 없음)',
    `season_no`     INT             UNSIGNED               NOT NULL        COMMENT '시즌 번호 (0:해당 랭킹 전 시즌, FK 없음)',
    `member_id`     VARCHAR(64)     COLLATE utf8mb4_bin    NOT NULL        COMMENT '멤버 ID (대소문자 구분)',
    `reason`        VARCHAR(255)                           NOT NULL        COMMENT '제재 사유',
    `created_by`    VARCHAR(64)                            NOT NULL        COMMENT '등록한 GM 식별자',
    `created_at`    DATETIME(3)                            NOT NULL        COMMENT '등록 시각 (UTC)',
    PRIMARY KEY (`ranking_id`, `season_no`, `member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='제재로 순위에서 제외할 멤버';
