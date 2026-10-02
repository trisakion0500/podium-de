-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_result
-- 작성 : 2026.10.02 trisakion
-- 내용 : 시즌 정산 결과와 보상 상태 (01_DESIGN 7.4). SETTLING에서 가순위로 적재하고 FINALIZING에서 확정한다.
--        (ranking_id, season_no) LIST COLUMNS 파티션. 자기 시즌과 다음 시즌이 모두 SETTLED일 때 EXCHANGE로 백업 테이블로 분리한다
--        (01_DESIGN 8.2, D-47). 전달이 끝나지 않은 시즌을 분리하면 보상 API가 남은 PENDING을 조회할 수 없다.
--        reward_status(보상 상태)와 sanctioned(표시 플래그)는 분리한다 (D-17).
--        의도적 복합 PK: 파티션 키가 PK에 포함되어야 한다 (D-35). member_id, reward_code는 대소문자를 구분한다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `ranking_result` (
    `ranking_id`       INT            UNSIGNED               NOT NULL                    COMMENT '랭킹 ID (ranking_def, FK 없음 — 파티션 테이블은 FK 불가)',
    `season_no`        INT            UNSIGNED               NOT NULL                    COMMENT '시즌 번호 (ranking_season)',
    `member_id`        VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                    COMMENT '멤버 ID (대소문자 구분)',
    `final_rank`       INT            UNSIGNED                           DEFAULT NULL    COMMENT '최종 순위 (NULL:제재로 제외)',
    `score`            BIGINT         UNSIGNED               NOT NULL                    COMMENT '시즌 최종 스코어',
    `achieved_at`      DATETIME(3)                           NOT NULL                    COMMENT '최종 스코어 달성 시각 (UTC)',
    `reward_code`      VARCHAR(64)    COLLATE utf8mb4_bin                DEFAULT NULL    COMMENT '판정된 보상 코드 (NULL:구간 밖, 대소문자 구분)',
    `reward_status`    TINYINT        UNSIGNED               NOT NULL                    COMMENT '보상 상태 (0:NONE 구간 밖, 1:PENDING 전달 전, 2:DELIVERED 게임 서버 ack 완료, 3:REJECTED 제재로 미지급) [codes.RewardStatus]',
    `reward_held`      TINYINT(1)                            NOT NULL    DEFAULT 0       COMMENT '보상 보류 (1:어뷰징 포인트 임계치 초과로 보류, 0:없음)',
    `sanctioned`       TINYINT(1)                            NOT NULL    DEFAULT 0       COMMENT '제재 표시 (1:제재됨, 0:없음) — 보상 상태와 별개',
    `delivered_at`     DATETIME(3)                                       DEFAULT NULL    COMMENT '보상 전달 ack 시각 (UTC)',
    PRIMARY KEY (`ranking_id`, `season_no`, `member_id`),
    KEY `ix_final_rank` (`ranking_id`, `season_no`, `final_rank`),
    KEY `ix_reward_status` (`ranking_id`, `season_no`, `reward_status`, `member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='시즌 정산 결과와 보상 상태 (시즌 파티션)'
PARTITION BY LIST COLUMNS (`ranking_id`, `season_no`) (
    PARTITION `p_init` VALUES IN ((0, 0))
);
