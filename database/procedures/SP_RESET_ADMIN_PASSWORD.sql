DROP PROCEDURE IF EXISTS `SP_RESET_ADMIN_PASSWORD`;
DELIMITER $$
CREATE PROCEDURE `SP_RESET_ADMIN_PASSWORD` (
    IN i_requester_id        INT UNSIGNED,    -- 요청자 GM 계정 ID (0:SYSTEM 관리 CLI)
    IN i_admin_account_id    INT UNSIGNED,    -- 초기화할 GM 계정 ID
    IN i_new_hash            VARCHAR(160)     -- 새 초기 비밀번호 해시 (원문은 받지 않는다)
) COMMENT 'GM 비밀번호 초기화 (admin): 변경 요구, 잠금 해제, 세션 모두 삭제'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_RESET_ADMIN_PASSWORD
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : POST /admin/v1/accounts/{id}/password-reset, 관리 CLI reset-password (01_DESIGN 10.4, D-74).
    --        RESULT: 0 성공, 1001 파라미터, 1404 계정 없음, 1405 권한 부족 [codes.SpResult]
    --        성공 데이터: admin_account_id, login_id, display_name, role, status (감사 로그용)
    --        - 요청자 역할을 FN_GET_ADMIN_ROLE로 다시 본다(ADMIN 이상). 앱이 확인했더라도 DB가 마지막 방어선이다.
    --        - 초기 비밀번호는 다음 로그인 때 바꿔야 한다(must_change_password = 1). 잠금도 함께 푼다 — 잠긴 계정을 되살리는
    --          흔한 경로라서다.
    --        - 사용중지 계정도 초기화할 수 있다. 다시 쓰려면 상태를 따로 활성으로 바꾼다.
    --        - CLI(요청자 0)는 updated_by를 NULL로 남긴다 (개발 컨벤션 5.3).
    --        - 잠금 순서: admin_account → admin_session (TABLE_LOCK_ORDER 14, 15).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)         DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_found            TINYINT             DEFAULT 0;
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
        IF i_requester_id IS NULL OR i_admin_account_id IS NULL OR i_admin_account_id = 0
           OR i_new_hash IS NULL OR i_new_hash = '' THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 3 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        START TRANSACTION;

        SELECT 1 INTO v_found
          FROM admin_account
         WHERE admin_account_id = i_admin_account_id
           FOR UPDATE;

        IF v_found = 0 THEN
            ROLLBACK;
            SELECT 1404 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE admin_account
           SET password_hash = i_new_hash, must_change_password = 1, password_changed_at = v_now,
               fail_count = 0, locked_until = NULL,
               updated_at = v_now, updated_by = NULLIF(i_requester_id, 0)
         WHERE admin_account_id = i_admin_account_id;

        DELETE FROM admin_session WHERE admin_account_id = i_admin_account_id;

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT admin_account_id, login_id, display_name, role, status
          FROM admin_account
         WHERE admin_account_id = i_admin_account_id;
    END proc_block;
END$$
DELIMITER ;
