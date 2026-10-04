-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_entry
-- 작성 : 2026.10.02 trisakion
-- 수정 : 2026.10.03 trisakion 정산 결과 컬럼 통합 (D-49)
-- 내용 : 시즌별 멤버 스코어와 정산 결과 (01_DESIGN 4.2, 7.4). 모든 랭킹이 공유하는 운영 테이블이다 (D-24).
--        (ranking_id, season_no) LIST COLUMNS 파티션 (D-10). 시즌 생성 시 SP_PARTITION_ADD가 p_r{id}_s{n}을 추가하고,
--        정의되지 않은 시즌으로의 INSERT는 에러가 난다(잘못된 파티션에 조용히 들어가는 것 방지).
--        p_init (0, 0)은 LIST 파티션 테이블에 최소 하나 필요한 미사용 파티션이다.
--        결과 컬럼(final_rank~delivered_at)은 진행 중에는 비어 있고 SETTLING·FINALIZING·DELIVERING에서 채운다.
--        결과를 별도 테이블로 복사하지 않기 위해 처음부터 둔다 — ranking_entry_settling과 EXCHANGE하려면 구조가 같아야 한다 (D-49).
--        정렬 인덱스는 두지 않는다 — 제출마다 쓰기 비용이 늘기 때문이며, 정산 시 ranking_entry_settling에만 잠시 추가한다 (D-21).
--        컬럼·인덱스를 바꾸면 ranking_entry_settling도 같게 바꿔야 EXCHANGE가 된다.
--        의도적 복합 PK: 파티션 키가 PK에 포함되어야 한다 (D-35). member_id, reward_code는 대소문자를 구분한다.
-- ------------------------------------------------------------------------------------------------------------ --
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
