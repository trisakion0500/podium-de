DROP PROCEDURE IF EXISTS `SP_INSERT_API_CREDENTIAL`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_API_CREDENTIAL` (
    IN i_key_name    VARCHAR(64),         -- 키 이름 (용도 식별, 예: game-server-live)
    IN i_key_hash    VARBINARY(32),       -- 키 SHA-256 해시 (원문은 받지 않는다)
    IN i_scopes      TINYINT UNSIGNED     -- 권한 비트 (1:WRITE, 2:READ, 4:REWARD 조합) [codes.ApiScope]
) COMMENT 'API 키 발급 (해시 저장)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_API_CREDENTIAL
    -- 작성 : 2026.10.06 trisakion
    -- 내용 : 발급 CLI(apikey.ts)가 호출한다 (01_DESIGN 10.1). 키 생성과 해시는 앱이 하고 SP는 해시만 받는다 —
    --        원문이 DB 세션·general log에 남지 않게 하기 위해서다.
    --        - 해시는 정확히 32바이트여야 한다. 파라미터를 BINARY(32)로 받으면 짧은 값이 0x00으로 채워져 길이 검사를
    --          통과하므로 VARBINARY로 받아 LENGTH를 확인한다.
    --        - 같은 해시(같은 키)는 ux_key_hash 위반으로 50001이 된다. 32바이트 난수라 정상 경로에서는 생기지 않는다.
    --        - 단일 INSERT라 자동 커밋으로 끝낸다. 다른 테이블을 잠그지 않는다 (TABLE_LOCK_ORDER 12).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT NOW(3);
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
        -- 7은 세 권한 비트의 합이다. 정의되지 않은 비트가 섞이면 앱이 모르는 권한이 생기므로 거부한다.
        IF i_key_name IS NULL OR TRIM(i_key_name) = ''
           OR i_key_hash IS NULL OR LENGTH(i_key_hash) <> 32
           OR i_scopes IS NULL OR i_scopes < 1 OR i_scopes > 7 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        INSERT INTO api_credential (key_name, key_hash, scopes, created_at)
        VALUES (i_key_name, i_key_hash, i_scopes, v_now);

        SELECT 0 AS RESULT;
        SELECT LAST_INSERT_ID() AS api_credential_id, v_now AS created_at;
    END proc_block;
END$$
DELIMITER ;
