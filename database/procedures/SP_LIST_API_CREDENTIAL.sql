DROP PROCEDURE IF EXISTS `SP_LIST_API_CREDENTIAL`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_API_CREDENTIAL` (
    IN i_include_revoked    TINYINT(1)    -- 1:폐기된 키 포함(CLI 목록), 0:활성 키만(API 인증 목록)
) COMMENT 'API 키 목록 (해시 포함)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_API_CREDENTIAL
    -- 작성 : 2026.10.06 trisakion
    -- 내용 : API가 기동 시와 30초마다 활성 키 목록을 읽어 메모리에 둔다 (01_DESIGN 10.1). CLI 목록도 같은 SP를 쓴다.
    --        - 요청마다 키 하나씩 DB를 조회하지 않기 위해 활성 키 전체를 한 번에 읽는다(API는 i_include_revoked=0).
    --          키는 운영자가 CLI로만 만들어 수가 적다.
    --        - key_hash를 돌려준다. 원문이 아니라 32바이트 난수의 해시라 이것으로 키를 복원할 수 없다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE sql_state          CHAR(5)         DEFAULT '00000';
    DECLARE error_no           INT             DEFAULT 0;
    DECLARE error_message      VARCHAR(512)    DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    proc_block: BEGIN
        IF i_include_revoked IS NULL OR i_include_revoked NOT IN (0, 1) THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT api_credential_id, key_name, key_hash, scopes, created_at, revoked_at
          FROM api_credential
         WHERE i_include_revoked = 1 OR revoked_at IS NULL
         ORDER BY api_credential_id;
    END proc_block;
END$$
DELIMITER ;
