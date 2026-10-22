DROP PROCEDURE IF EXISTS `SP_INSERT_ADMIN_ACCOUNT`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_ADMIN_ACCOUNT` (
    IN i_requester_id     INT UNSIGNED,        -- 요청자 GM 계정 ID (0:SYSTEM 관리 CLI)
    IN i_login_id         VARCHAR(64),         -- 로그인 아이디
    IN i_display_name     VARCHAR(64),         -- 표시 이름
    IN i_role             TINYINT UNSIGNED,    -- 역할 (1:VIEWER, 2:OPERATOR, 3:ADMIN) [codes.AdminRole]
    IN i_password_hash    VARCHAR(160)         -- 초기 비밀번호 해시 (원문은 받지 않는다)
) COMMENT 'GM 계정 생성 (admin, 초기 비밀번호는 첫 로그인 때 변경)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_ADMIN_ACCOUNT
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : POST /admin/v1/accounts, 관리 CLI create (01_DESIGN 10.4, D-74).
    --        RESULT: 0 성공, 1001 파라미터, 1405 권한 부족, 1407 login_id 중복 [codes.SpResult]
    --        성공 데이터: admin_account_id, login_id, display_name, role, status, created_at
    --        - 요청자 역할을 FN_GET_ADMIN_ROLE로 다시 본다(ADMIN 이상).
    --        - 중복은 미리 조회하지 않고 ux_login_id 위반(1062)으로 판단한다. 조회 후 INSERT는 동시 생성 사이에 틈이 있다.
    --          콜레이션이 대소문자를 무시하므로 'Admin'과 'admin'도 중복이다 — 비슷한 아이디로 혼동을 만들지 않게 한다.
    --        - 초기 비밀번호는 must_change_password = 1이다.
    --        - 단일 INSERT라 자동 커밋으로 끝낸다 (TABLE_LOCK_ORDER 14).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)         DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_duplicate        TINYINT             DEFAULT 0;
    DECLARE v_id               INT UNSIGNED;
    DECLARE sql_state          CHAR(5)             DEFAULT '00000';
    DECLARE error_no           INT                 DEFAULT 0;
    DECLARE error_message      VARCHAR(512)        DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        ROLLBACK;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;
    -- 1062(중복 키)만 따로 받는다. 더 구체적인 핸들러가 SQLEXCEPTION 핸들러보다 먼저 선택된다.
    DECLARE CONTINUE HANDLER FOR 1062 SET v_duplicate = 1;

    proc_block: BEGIN
        IF i_requester_id IS NULL
           OR i_login_id IS NULL OR TRIM(i_login_id) = ''
           OR i_display_name IS NULL OR TRIM(i_display_name) = ''
           OR i_role IS NULL OR i_role NOT IN (1, 2, 3)
           OR i_password_hash IS NULL OR i_password_hash = '' THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 3 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        INSERT INTO admin_account
            (login_id, display_name, role, status, password_hash, must_change_password, fail_count, locked_until,
             password_changed_at, created_at, created_by, updated_at, updated_by)
        VALUES
            (i_login_id, i_display_name, i_role, 1, i_password_hash, 1, 0, NULL,
             v_now, v_now, i_requester_id, v_now, NULL);

        IF v_duplicate = 1 THEN
            SELECT 1407 AS RESULT;
            LEAVE proc_block;
        END IF;
        SET v_id = LAST_INSERT_ID();

        SELECT 0 AS RESULT;
        SELECT admin_account_id, login_id, display_name, role, status, created_at
          FROM admin_account
         WHERE admin_account_id = v_id;
    END proc_block;
END$$
DELIMITER ;
