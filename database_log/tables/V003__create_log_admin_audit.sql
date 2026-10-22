-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : log_admin_audit (로그 DB podium_de_log)
-- 작성 : 2026.10.22 trisakion
-- 내용 : 관리 API·관리 CLI 조작 감사 로그 (01_DESIGN 10.4, D-74). 로그인 성공·실패, 비밀번호, 계정 조작, GM 조작을 남긴다.
--        - 추가 전용이다. 적재 SP만 있고 고치거나 지우는 SP는 없다. 앱 계정은 EXECUTE만 있어 직접 바꿀 수 없다.
--        - 메인 DB와 FK를 걸 수 없어(물리 분리) 실행자 아이디·역할을 스냅샷으로 둔다 (개발 컨벤션 7장).
--        - 건수가 적어 파티션과 자동 삭제를 두지 않는다. 로그 정리 잡(log_ranking_submit 전용)의 대상이 아니다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `log_admin_audit` (
    `log_admin_audit_id`    BIGINT         UNSIGNED    NOT NULL    AUTO_INCREMENT    COMMENT '감사 로그 ID',
    `admin_account_id`      INT            UNSIGNED    NOT NULL                      COMMENT '실행자 계정 ID (0:SYSTEM CLI, 로그인 실패는 대상 계정 또는 0)',
    `login_id`              VARCHAR(64)                NOT NULL                      COMMENT '실행자 아이디 스냅샷 (로그인 실패는 입력값)',
    `role`                  TINYINT        UNSIGNED    NOT NULL                      COMMENT '실행 시 역할 스냅샷 (0:미인증) [codes.AdminRole]',
    `action`                VARCHAR(64)                NOT NULL                      COMMENT '조작 (예: auth.login, account.create)',
    `target_type`           VARCHAR(32)                            DEFAULT NULL      COMMENT '대상 종류 (account, ranking, season 등)',
    `target_id`             VARCHAR(64)                            DEFAULT NULL      COMMENT '대상 ID',
    `result_code`           INT            UNSIGNED    NOT NULL                      COMMENT '결과 코드 (0:성공)',
    `before_json`           JSON                                   DEFAULT NULL      COMMENT '변경 전 (비밀 필드 가림)',
    `after_json`            JSON                                   DEFAULT NULL      COMMENT '변경 후 (비밀 필드 가림)',
    `request_id`            VARCHAR(36)                NOT NULL                      COMMENT '요청 ID (x-request-id, CLI는 실행마다 새로)',
    `client_ip`             VARCHAR(45)                NOT NULL                      COMMENT '요청 IP (CLI는 빈 문자열)',
    `created_at`            DATETIME(3)                NOT NULL                      COMMENT '기록 시각 (UTC)',
    PRIMARY KEY (`log_admin_audit_id`),
    KEY `ix_created_at` (`created_at`),
    KEY `ix_admin_account_id_created_at` (`admin_account_id`, `created_at`),
    KEY `ix_target` (`target_type`, `target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='GM 조작 감사 로그 (추가 전용)';
