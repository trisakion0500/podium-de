DROP PROCEDURE IF EXISTS `SP_INSERT_LOG_ADMIN_AUDIT`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_LOG_ADMIN_AUDIT` (
    IN i_admin_account_id    INT UNSIGNED,        -- 실행자 계정 ID (0:SYSTEM CLI, 로그인 실패는 대상 계정 또는 0)
    IN i_login_id            VARCHAR(64),         -- 실행자 아이디 스냅샷 (로그인 실패는 입력값)
    IN i_role                TINYINT UNSIGNED,    -- 실행 시 역할 스냅샷 (0:미인증) [codes.AdminRole]
    IN i_action              VARCHAR(64),         -- 조작 (예: auth.login, account.create)
    IN i_target_type         VARCHAR(32),         -- 대상 종류 (NULL:없음)
    IN i_target_id           VARCHAR(64),         -- 대상 ID (NULL:없음)
    IN i_result_code         INT UNSIGNED,        -- 결과 코드 (0:성공)
    IN i_before_json         JSON,                -- 변경 전 (비밀 필드는 앱이 가린 뒤 넘긴다)
    IN i_after_json          JSON,                -- 변경 후 (비밀 필드는 앱이 가린 뒤 넘긴다)
    IN i_request_id          VARCHAR(36),         -- 요청 ID (x-request-id, CLI는 실행마다 새로)
    IN i_client_ip           VARCHAR(45)          -- 요청 IP (CLI는 빈 문자열)
) COMMENT 'GM 조작 감사 로그 1건 기록 (로그 DB, 메인 SP 커밋 뒤 별도 커넥션으로 호출)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_LOG_ADMIN_AUDIT
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : 관리 API·관리 CLI가 조작 뒤 로그 DB 전용 풀로 부른다 (01_DESIGN 10.4, D-74).
    --        - 메인 트랜잭션과 묶이지 않는다. 실패해도 조작은 되돌리지 않고 앱이 앱 로그에 오류로 남긴다 (개발 컨벤션 7장).
    --        - 추가 전용 테이블이다. 고치거나 지우는 SP는 만들지 않는다.
    --        - 순수 적재 SP라 성공 시 두 번째 결과셋을 두지 않는다 (개발 컨벤션 4.4 예외).
    --        - 아이디는 64자로 자른다. 로그인 실패의 입력값은 형식 검증 전 값이라 길 수 있다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE sql_state          CHAR(5)         DEFAULT '00000';
    DECLARE error_no           INT             DEFAULT 0;
    DECLARE error_message      VARCHAR(512)    DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        ROLLBACK;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    INSERT INTO log_admin_audit
        (admin_account_id, login_id, role, action, target_type, target_id, result_code,
         before_json, after_json, request_id, client_ip, created_at)
    VALUES
        (i_admin_account_id, LEFT(IFNULL(i_login_id, ''), 64), i_role, i_action, i_target_type, i_target_id, i_result_code,
         i_before_json, i_after_json, i_request_id, IFNULL(i_client_ip, ''), UTC_TIMESTAMP(3));

    SELECT 0 AS RESULT;
END$$
DELIMITER ;
