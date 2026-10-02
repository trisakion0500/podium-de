-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_hall
-- 작성 : 2026.10.02 trisakion
-- 내용 : 시즌별 상위 hall_size 영구 보관 (01_DESIGN 8.4, D-23). FINALIZING에서 제재 반영 후 적재한다.
--        지급 후 제재 시 sanctioned를 함께 갱신한다.
--        의도적 복합 PK (ranking_id, season_no, final_rank): 시즌 안의 순위가 자연키다 (D-35).
--        ranking_id는 FK 없음: 키 구조는 설계를 따르며, 설계에 FK가 없다 (D-35). member_id는 대소문자를 구분한다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `ranking_hall` (
    `ranking_id`    INT            UNSIGNED               NOT NULL                 COMMENT '랭킹 ID (ranking_def, FK 없음)',
    `season_no`     INT            UNSIGNED               NOT NULL                 COMMENT '시즌 번호',
    `final_rank`    INT            UNSIGNED               NOT NULL                 COMMENT '최종 순위',
    `member_id`     VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                 COMMENT '멤버 ID (대소문자 구분)',
    `score`         BIGINT         UNSIGNED               NOT NULL                 COMMENT '시즌 최종 스코어',
    `sanctioned`    TINYINT(1)                            NOT NULL    DEFAULT 0    COMMENT '제재 표시 (1:지급 후 제재됨, 0:없음)',
    PRIMARY KEY (`ranking_id`, `season_no`, `final_rank`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='시즌별 상위 순위 영구 보관';
