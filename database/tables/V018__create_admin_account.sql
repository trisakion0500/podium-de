-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : admin_account
-- 작성 : 2026.10.22 trisakion
-- 내용 : 관리 API GM 계정 (01_DESIGN 10.4, D-74). admin이 만들고 본인 가입은 없다. 첫 admin은 CLI로 만든다.
--        - 계정은 지우지 않는다. 감사 로그(로그 DB)의 admin_account_id를 추적하기 위해서다. 사용중지는 status로 한다.
--        - 비밀번호는 scrypt 해시만 둔다. 파라미터를 문자열에 함께 저장해 나중에 올려도 기존 해시를 검증할 수 있다.
--        - 로그인 실패 횟수와 잠금은 이 행에 둔다. 인스턴스가 여러 개여도 한 계정의 한도가 하나로 유지된다.
--        - created_by 0은 CLI(SYSTEM)다 (개발 컨벤션 5.3).
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `admin_account` (
    `admin_account_id`        INT            UNSIGNED    NOT NULL    AUTO_INCREMENT    COMMENT 'GM 계정 ID',
    `login_id`                VARCHAR(64)                NOT NULL                      COMMENT '로그인 아이디',
    `display_name`            VARCHAR(64)                NOT NULL                      COMMENT '표시 이름 (감사 로그 스냅샷)',
    `role`                    TINYINT        UNSIGNED    NOT NULL                      COMMENT '역할 (1:VIEWER 조회, 2:OPERATOR GM 조작, 3:ADMIN 계정 관리 포함) [codes.AdminRole]',
    `status`                  TINYINT        UNSIGNED    NOT NULL                      COMMENT '상태 (1:ACTIVE 활성, 2:DISABLED 사용중지) [codes.AdminStatus]',
    `password_hash`           VARCHAR(160)               NOT NULL                      COMMENT '비밀번호 해시 (scrypt$N$r$p$솔트$해시)',
    `must_change_password`    TINYINT        UNSIGNED    NOT NULL                      COMMENT '비밀번호 변경 필요 (1:초기 비밀번호)',
    `fail_count`              TINYINT        UNSIGNED    NOT NULL                      COMMENT '연속 로그인 실패 횟수',
    `locked_until`            DATETIME(3)                            DEFAULT NULL      COMMENT '잠금 해제 시각 (UTC, NULL:잠금 없음)',
    `password_changed_at`     DATETIME(3)                NOT NULL                      COMMENT '비밀번호 설정 시각 (UTC)',
    `created_at`              DATETIME(3)                NOT NULL                      COMMENT '생성 시각 (UTC)',
    `created_by`              INT            UNSIGNED    NOT NULL                      COMMENT '생성자 계정 ID (0:SYSTEM CLI)',
    `updated_at`              DATETIME(3)                NOT NULL                      COMMENT '최종 수정 시각 (UTC)',
    `updated_by`              INT            UNSIGNED                DEFAULT NULL      COMMENT '최종 수정자 계정 ID',
    PRIMARY KEY (`admin_account_id`),
    UNIQUE KEY `ux_login_id` (`login_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='GM 계정';
