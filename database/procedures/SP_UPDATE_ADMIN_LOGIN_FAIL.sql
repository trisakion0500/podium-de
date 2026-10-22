DROP PROCEDURE IF EXISTS `SP_UPDATE_ADMIN_LOGIN_FAIL`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_ADMIN_LOGIN_FAIL` (
    IN i_admin_account_id    INT UNSIGNED    -- 비밀번호가 틀린 GM 계정 ID
) COMMENT 'GM 로그인 실패 횟수 증가, 5회째에 15분 잠금'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_ADMIN_LOGIN_FAIL
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : 로그인에서 비밀번호가 틀렸을 때 앱이 부른다 (01_DESIGN 10.4, D-74).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: fail_count, locked_until (갱신 후, 계정이 없으면 0행)
    --        - 횟수를 계정 행에 둬서 인스턴스가 여러 개여도 한도가 하나다. 동시 실패는 조건부 UPDATE 하나라 횟수가 빠지지 않는다.
    --        - 5회째 실패에 잠그고 횟수를 0으로 되돌린다. 잠금이 풀린 뒤 다시 5회가 허용된다.
    --        - 이미 잠긴 동안에는 세지 않는다(WHERE 조건). 잠긴 동안의 시도가 잠금을 계속 늘리지 않게 한다.
    --        - SET은 왼쪽부터 평가되고 뒤 식은 앞에서 바꾼 값을 본다. 그래서 locked_until을 fail_count보다 먼저 계산한다.
    --        - 계정 정보 수정이 아니라 updated_at·updated_by는 바꾸지 않는다.
    --        - 단일 UPDATE라 자동 커밋으로 끝낸다 (TABLE_LOCK_ORDER 14).
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
        IF i_admin_account_id IS NULL OR i_admin_account_id = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE admin_account
           SET locked_until = IF(fail_count + 1 >= 5, v_now + INTERVAL 15 MINUTE, NULL),
               fail_count = IF(fail_count + 1 >= 5, 0, fail_count + 1)
         WHERE admin_account_id = i_admin_account_id
           AND (locked_until IS NULL OR locked_until <= v_now);

        SELECT 0 AS RESULT;
        SELECT fail_count, locked_until
          FROM admin_account
         WHERE admin_account_id = i_admin_account_id;
    END proc_block;
END$$
DELIMITER ;
