DROP PROCEDURE IF EXISTS `SP_UPDATE_ADMIN_ACCOUNT`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_ADMIN_ACCOUNT` (
    IN i_requester_id        INT UNSIGNED,        -- 요청자 GM 계정 ID
    IN i_admin_account_id    INT UNSIGNED,        -- 바꿀 GM 계정 ID
    IN i_display_name        VARCHAR(64),         -- 새 표시 이름 (NULL:유지)
    IN i_role                TINYINT UNSIGNED,    -- 새 역할 (NULL:유지, 1:VIEWER, 2:OPERATOR, 3:ADMIN) [codes.AdminRole]
    IN i_status              TINYINT UNSIGNED     -- 새 상태 (NULL:유지, 1:ACTIVE, 2:DISABLED) [codes.AdminStatus]
) COMMENT 'GM 계정 이름·역할·상태 변경 (admin, 사용중지 시 세션 모두 삭제)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_ADMIN_ACCOUNT
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : PATCH /admin/v1/accounts/{id} (01_DESIGN 10.4, D-74).
    --        RESULT: 0 성공, 1001 파라미터, 1404 계정 없음, 1405 권한 부족, 1406 자기 계정의 역할·상태 변경 [codes.SpResult]
    --        성공 데이터: 변경 전(before_*)과 변경 후 값 1행 (감사 로그용)
    --        - 요청자 역할을 FN_GET_ADMIN_ROLE로 다시 본다(ADMIN 이상).
    --        - 자기 계정의 역할 변경과 사용중지를 거부한다. admin이 한 명도 남지 않는 실수를 막는다. 같은 값은 변경이 아니라 허용한다.
    --          현재 값과 비교해야 해서 행을 잠근 뒤 판단한다.
    --        - 사용중지하면 같은 트랜잭션에서 그 계정의 세션을 모두 지운다. 다음 요청부터 바로 막힌다.
    --        - 잠금 순서: admin_account → admin_session (TABLE_LOCK_ORDER 14, 15).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)         DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_name             VARCHAR(64)         DEFAULT NULL;
    DECLARE v_role             TINYINT UNSIGNED    DEFAULT NULL;
    DECLARE v_status           TINYINT UNSIGNED    DEFAULT NULL;
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

    proc_block: BEGIN
        IF i_requester_id IS NULL OR i_requester_id = 0 OR i_admin_account_id IS NULL OR i_admin_account_id = 0
           OR (i_display_name IS NOT NULL AND TRIM(i_display_name) = '')
           OR (i_role IS NOT NULL AND i_role NOT IN (1, 2, 3))
           OR (i_status IS NOT NULL AND i_status NOT IN (1, 2)) THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 3 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        START TRANSACTION;

        SELECT display_name, role, status INTO v_name, v_role, v_status
          FROM admin_account
         WHERE admin_account_id = i_admin_account_id
           FOR UPDATE;

        IF v_status IS NULL THEN
            ROLLBACK;
            SELECT 1404 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF i_admin_account_id = i_requester_id
           AND ((i_role IS NOT NULL AND i_role <> v_role) OR (i_status IS NOT NULL AND i_status <> v_status)) THEN
            ROLLBACK;
            SELECT 1406 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE admin_account
           SET display_name = IFNULL(i_display_name, display_name),
               role = IFNULL(i_role, role),
               status = IFNULL(i_status, status),
               updated_at = v_now, updated_by = i_requester_id
         WHERE admin_account_id = i_admin_account_id;

        IF i_status = 2 THEN
            DELETE FROM admin_session WHERE admin_account_id = i_admin_account_id;
        END IF;

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT admin_account_id, login_id, display_name, role, status,
               v_name AS before_display_name, v_role AS before_role, v_status AS before_status
          FROM admin_account
         WHERE admin_account_id = i_admin_account_id;
    END proc_block;
END$$
DELIMITER ;
