-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_submit_key
-- 작성 : 2026.10.02 trisakion
-- 내용 : 제출 멱등 키 (01_DESIGN 4.4, D-48). 반영과 같은 트랜잭션에서 기록해야 하므로 메인 DB에 둔다.
--        반영 성공과 하드 검증 거부만 기록한다. 재전송 판별(같은 내용 = member_id, input_value)과
--        재전송 시 같은 거부 반환, 검수 목록(하드 검증 위반 이력자)에 쓴다.
--        이력 컬럼(meta, result_score 등)은 두지 않는다 — 행을 작게 유지하는 것이 분리 목적이다. 이력은 로그 DB에 있다.
--        (ranking_id, season_no) LIST COLUMNS 파티션. SETTLED 후 EXCHANGE로 백업 테이블로 분리한다 (01_DESIGN 8.2).
--        의도적 복합 PK: 파티션 키가 PK에 포함되어야 하며, 시즌 안의 request_id가 멱등 키다 (D-35).
-- ------------------------------------------------------------------------------------------------------------ --
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
