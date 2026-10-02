-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_entry
-- 작성 : 2026.10.02 trisakion
-- 내용 : 진행 중 시즌의 멤버별 현재 스코어 (01_DESIGN 4.2). 모든 랭킹이 공유하는 운영 테이블이다 (D-24).
--        (ranking_id, season_no) LIST COLUMNS 파티션 (D-10). 시즌 생성 시 SP_PARTITION_ADD가 p_r{id}_s{n}을 추가하고,
--        정의되지 않은 시즌으로의 INSERT는 에러가 난다(잘못된 파티션에 조용히 들어가는 것 방지).
--        p_init (0, 0)은 LIST 파티션 테이블에 최소 하나 필요한 미사용 파티션이다.
--        정렬 인덱스는 두지 않는다 — 제출마다 쓰기 비용이 늘기 때문이며, 정산 시 ranking_entry_settling에 추가한다 (D-21).
--        컬럼·인덱스를 바꾸면 ranking_entry_settling도 같게 바꿔야 EXCHANGE가 된다.
--        의도적 복합 PK: 파티션 키가 PK에 포함되어야 한다 (D-35). member_id는 대소문자를 구분한다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `ranking_entry` (
    `ranking_id`     INT            UNSIGNED               NOT NULL                    COMMENT '랭킹 ID (ranking_def, FK 없음 — 파티션 테이블은 FK 불가)',
    `season_no`      INT            UNSIGNED               NOT NULL                    COMMENT '시즌 번호 (ranking_season)',
    `member_id`      VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                    COMMENT '멤버 ID (게임 서버 식별자, 대소문자 구분)',
    `score`          BIGINT         UNSIGNED               NOT NULL                    COMMENT '현재 스코어',
    `achieved_at`    DATETIME(3)                           NOT NULL                    COMMENT '현재 스코어 달성 시각 (UTC, MySQL NOW(3)) — 동점 시 먼저 달성한 쪽이 위',
    `version`        INT            UNSIGNED               NOT NULL    DEFAULT 1       COMMENT '값 변경 버전 (실제로 바뀔 때만 증가, Redis 반영 순서 비교용)',
    `source_seq`     BIGINT         UNSIGNED                           DEFAULT NULL    COMMENT '게임 서버 소스 시퀀스 (LATEST 전용, 2차 범위)',
    `updated_at`     DATETIME(3)                           NOT NULL                    COMMENT '값 변경 시각 (UTC, 실제로 바뀔 때만 갱신) — 리컨실러 워터마크 스캔 기준',
    PRIMARY KEY (`ranking_id`, `season_no`, `member_id`),
    KEY `ix_updated_at` (`ranking_id`, `season_no`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='진행 중 시즌의 멤버별 스코어 (운영 테이블, 시즌 파티션)'
PARTITION BY LIST COLUMNS (`ranking_id`, `season_no`) (
    PARTITION `p_init` VALUES IN ((0, 0))
);
