-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : admin_session
-- 작성 : 2026.10.22 trisakion
-- 내용 : 관리 API 로그인 세션 (01_DESIGN 10.4, D-74). 쿠키에는 32바이트 난수 토큰을 주고 여기에는 SHA-256 해시만 둔다.
--        DB가 유출돼도 그 값으로 로그인할 수 없다. 요청마다 해시로 찾으므로 ux_token_hash가 조회 경로다.
--        - 역할은 복사하지 않는다. 매번 계정 행에서 읽어 역할 변경이 다음 요청부터 적용되게 한다.
--        - 정리 잡은 두지 않는다. 로그인할 때 그 계정의 만료 행을 지운다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `admin_session` (
    `admin_session_id`    BIGINT         UNSIGNED    NOT NULL    AUTO_INCREMENT    COMMENT '세션 ID',
    `admin_account_id`    INT            UNSIGNED    NOT NULL                      COMMENT 'GM 계정 ID',
    `token_hash`          BINARY(32)                 NOT NULL                      COMMENT '세션 토큰 SHA-256 해시',
    `created_at`          DATETIME(3)                NOT NULL                      COMMENT '로그인 시각 (UTC)',
    `last_seen_at`        DATETIME(3)                NOT NULL                      COMMENT '마지막 요청 시각 (UTC, 1분 단위 갱신)',
    `expires_at`          DATETIME(3)                NOT NULL                      COMMENT '최대 수명 만료 시각 (UTC)',
    `client_ip`           VARCHAR(45)                NOT NULL                      COMMENT '로그인 IP',
    PRIMARY KEY (`admin_session_id`),
    UNIQUE KEY `ux_token_hash` (`token_hash`),
    KEY `ix_admin_account_id` (`admin_account_id`),
    CONSTRAINT `fk_admin_session_account` FOREIGN KEY (`admin_account_id`) REFERENCES `admin_account` (`admin_account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='GM 로그인 세션';
