DROP PROCEDURE IF EXISTS `SP_DELETE_ADMIN_SESSION`;
DELIMITER $$
CREATE PROCEDURE `SP_DELETE_ADMIN_SESSION` (
    IN i_admin_session_id    BIGINT UNSIGNED    -- 끝낼 세션 ID (인증 가드가 확인한 현재 세션)
) COMMENT 'GM 로그아웃 (세션 1개 삭제)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_DELETE_ADMIN_SESSION
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : POST /admin/v1/auth/logout (01_DESIGN 10.4). 이미 지워진 세션도 성공으로 본다(로그아웃 재시도는 멱등).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        - 세션 ID는 앱이 쿠키로 확인한 현재 세션의 것만 넘긴다. 다른 세션을 지우는 경로는 없다.
    --        - 단일 DELETE라 자동 커밋으로 끝낸다 (TABLE_LOCK_ORDER 15).
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

    proc_block: BEGIN
        IF i_admin_session_id IS NULL OR i_admin_session_id = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        DELETE FROM admin_session WHERE admin_session_id = i_admin_session_id;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
