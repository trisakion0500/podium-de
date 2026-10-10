DROP PROCEDURE IF EXISTS `SP_REVOKE_API_CREDENTIAL`;
DELIMITER $$
CREATE PROCEDURE `SP_REVOKE_API_CREDENTIAL` (
    IN i_api_credential_id    INT UNSIGNED    -- 폐기할 API 키 ID
) COMMENT 'API 키 폐기 (활성 키만)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_REVOKE_API_CREDENTIAL
    -- 작성 : 2026.10.06 trisakion
    -- 수정 : 2026.10.10 trisakion NOW(3) → UTC_TIMESTAMP(3) (호출 세션 time_zone과 무관하게 UTC, D-66)
    -- 내용 : 폐기 CLI(apikey.ts)가 호출한다 (01_DESIGN 10.1). API는 다음 재조회(최대 30초) 때 이 키를 목록에서 뺀다.
    --        - 활성 → 폐기 한 방향만 허용한다. 조건부 UPDATE(revoked_at IS NULL)로 처음 폐기한 시각을 덮어쓰지 않는다.
    --        - 갱신 0건이면 없는 키인지 이미 폐기된 키인지 구분해 돌려준다. 운영자가 ID를 잘못 넣었는지 바로 알게 한다.
    --        - 단일 UPDATE라 자동 커밋으로 끝낸다. 다른 테이블을 잠그지 않는다 (TABLE_LOCK_ORDER 12).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_revoked_at       DATETIME(3)     DEFAULT NULL;
    DECLARE v_found            TINYINT         DEFAULT 0;
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
        IF i_api_credential_id IS NULL OR i_api_credential_id = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE api_credential
           SET revoked_at = v_now
         WHERE api_credential_id = i_api_credential_id
           AND revoked_at IS NULL;

        IF ROW_COUNT() = 0 THEN
            SELECT 1, revoked_at INTO v_found, v_revoked_at
              FROM api_credential
             WHERE api_credential_id = i_api_credential_id;
            IF v_found = 0 THEN
                SELECT 1201 AS RESULT;
            ELSE
                SELECT 1202 AS RESULT;
            END IF;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT i_api_credential_id AS api_credential_id, v_now AS revoked_at;
    END proc_block;
END$$
DELIMITER ;
