-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_submit_log (로그 DB podium_de_log)
-- 작성 : 2026.10.02 trisakion
-- 내용 : 제출 처리 이력 (01_DESIGN 4.5, D-48). 결과와 무관하게 모든 제출 요청을 남긴다 — 감사, 어뷰징 조사, 장애 조사용.
--        앱이 응답을 만든 뒤 로그 DB 전용 풀로 기록한다. 메인 트랜잭션과 묶지 않으며 실패해도 서비스에 영향이 없다.
--        보관은 시즌과 무관하게 날짜 기준(LOG_RETENTION_DAYS). 일 단위 RANGE 파티션을 로그 정리 잡이 만들고 지운다.
--        p_max는 안전망이다 — 정리 잡이 멈춰도 INSERT가 실패하지 않으며, p_max에 행이 쌓이면 알린다 (01_DESIGN 11.4).
--        PK에 created_at을 포함한다: 파티션 키가 모든 유니크 키에 포함되어야 한다.
--        FK 없음: 메인 DB와 물리적으로 분리된 DB다 (개발 컨벤션 7장). 식별자는 대소문자를 구분한다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `ranking_submit_log` (
    `ranking_submit_log_id`    BIGINT         UNSIGNED               NOT NULL    AUTO_INCREMENT    COMMENT '로그 ID',
    `created_at`               DATETIME(3)                           NOT NULL                      COMMENT '기록 시각 (UTC, 로그 DB 시각) — 파티션 키',
    `ranking_id`               INT            UNSIGNED               NOT NULL                      COMMENT '랭킹 ID (메인 DB ranking_def, FK 없음 — 물리 분리 DB)',
    `season_no`                INT            UNSIGNED               NOT NULL                      COMMENT '요청의 seasonNo',
    `request_id`               VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                      COMMENT '멱등 키 (게임 서버 requestId, 대소문자 구분)',
    `member_id`                VARCHAR(64)    COLLATE utf8mb4_bin    NOT NULL                      COMMENT '멤버 ID (대소문자 구분)',
    `input_value`              BIGINT                                NOT NULL                      COMMENT '입력 값 (BEST:이번 기록, SUM:부호 있는 증분)',
    `result_code`              INT            UNSIGNED               NOT NULL                      COMMENT '처리 결과 (0:성공, 그 외 API 결과 코드)',
    `rejected`                 VARCHAR(32)                                       DEFAULT NULL      COMMENT '하드 검증 거부 사유',
    `replayed`                 TINYINT(1)                            NOT NULL    DEFAULT 0         COMMENT '재전송 여부 (1:재전송, 0:최초)',
    `result_score`             BIGINT         UNSIGNED                           DEFAULT NULL      COMMENT '처리 후 스코어 (SP까지 간 경우)',
    `version`                  INT            UNSIGNED                           DEFAULT NULL      COMMENT '처리 후 entry version (SP까지 간 경우)',
    `meta`                     JSON                                              DEFAULT NULL      COMMENT '게임 서버 맥락 (매치 ID 등, 해석하지 않음)',
    PRIMARY KEY (`ranking_submit_log_id`, `created_at`),
    KEY `ix_member_id` (`ranking_id`, `member_id`, `created_at`),
    KEY `ix_request_id` (`request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='제출 처리 이력 (로그 DB, 일 단위 파티션)'
PARTITION BY RANGE COLUMNS (`created_at`) (
    PARTITION `p_max` VALUES LESS THAN (MAXVALUE)
);
