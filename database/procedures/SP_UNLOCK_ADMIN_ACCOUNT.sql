DROP PROCEDURE IF EXISTS `SP_UNLOCK_ADMIN_ACCOUNT`;
DELIMITER $$
CREATE PROCEDURE `SP_UNLOCK_ADMIN_ACCOUNT` (
    IN i_requester_id        INT UNSIGNED,    -- 요청자 GM 계정 ID
    IN i_admin_account_id    INT UNSIGNED     -- 잠금을 풀 GM 계정 ID
) COMMENT 'GM 계정 로그인 잠금 해제 (admin)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UNLOCK_ADMIN_ACCOUNT
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : POST /admin/v1/accounts/{id}/unlock (01_DESIGN 10.4, D-74). 계정 단위 잠금이라 남이 일부러 틀려 잠근 계정을
    --        admin이 바로 풀 수 있게 한다. 잠기지 않은 계정도 성공이다(실패 횟수만 0으로).
    --        RESULT: 0 성공, 1001 파라미터, 1404 계정 없음, 1405 권한 부족 [codes.SpResult]
    --        성공 데이터: admin_account_id, login_id
    --        - 요청자 역할을 FN_GET_ADMIN_ROLE로 다시 본다(ADMIN 이상).
    --        - 단일 UPDATE라 자동 커밋으로 끝낸다. updated_at이 늘 바뀌므로 ROW_COUNT 0은 계정이 없다는 뜻이다 (TABLE_LOCK_ORDER 14).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
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

    proc_block: BEGIN
        IF i_requester_id IS NULL OR i_requester_id = 0 OR i_admin_account_id IS NULL OR i_admin_account_id = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 3 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE admin_account
           SET fail_count = 0, locked_until = NULL, updated_at = v_now, updated_by = i_requester_id
         WHERE admin_account_id = i_admin_account_id;

        IF ROW_COUNT() = 0 THEN
            SELECT 1404 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT admin_account_id, login_id
          FROM admin_account
         WHERE admin_account_id = i_admin_account_id;
    END proc_block;
END$$
DELIMITER ;
