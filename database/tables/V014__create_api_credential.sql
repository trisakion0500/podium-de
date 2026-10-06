-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : api_credential
-- 작성 : 2026.10.06 trisakion
-- 내용 : 서버 간 호출 API 키 (01_DESIGN 10.1, D-54). 키 원문은 저장하지 않고 SHA-256 해시만 둔다.
--        키가 32바이트 난수라 느린 해시가 필요 없고, 해시가 고정 32바이트라 BINARY(32)로 둔다.
--        API는 30초마다 활성 키(revoked_at IS NULL) 전체를 한 번에 읽는다. 행이 적고 대부분 활성이라
--        인덱스를 타면 행마다 PK를 다시 읽어 풀 스캔보다 비싸므로 revoked_at 인덱스는 두지 않는다.
--        폐기한 행도 지우지 않는다 — 로그에 남은 api_credential_id를 추적하기 위해서다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `api_credential` (
    `api_credential_id`    INT            UNSIGNED    NOT NULL    AUTO_INCREMENT    COMMENT 'API 키 ID',
    `key_name`             VARCHAR(64)                NOT NULL                      COMMENT '키 이름 (용도 식별, 예: game-server-live)',
    `key_hash`             BINARY(32)                 NOT NULL                      COMMENT '키 SHA-256 해시',
    `scopes`               TINYINT        UNSIGNED    NOT NULL                      COMMENT '권한 비트 (1:WRITE 제출, 2:READ 조회, 4:REWARD 보상 수신) [codes.ApiScope]',
    `created_at`           DATETIME(3)                NOT NULL                      COMMENT '발급 시각 (UTC)',
    `revoked_at`           DATETIME(3)                            DEFAULT NULL      COMMENT '폐기 시각 (UTC, NULL:활성)',
    PRIMARY KEY (`api_credential_id`),
    UNIQUE KEY `ux_key_hash` (`key_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='서버 간 호출 API 키';
