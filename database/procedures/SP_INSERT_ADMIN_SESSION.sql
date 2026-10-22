DROP PROCEDURE IF EXISTS `SP_INSERT_ADMIN_SESSION`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_ADMIN_SESSION` (
    IN i_admin_account_id    INT UNSIGNED,         -- 로그인한 GM 계정 ID
    IN i_password_hash       VARCHAR(160),         -- 앱이 비교에 쓴 비밀번호 해시 (그 사이 바뀌었는지 확인)
    IN i_token_hash          VARBINARY(32),        -- 세션 토큰 SHA-256 해시 (원문은 받지 않는다)
    IN i_client_ip           VARCHAR(45),          -- 로그인 IP
    IN i_idle_min            SMALLINT UNSIGNED,    -- 유휴 만료(분), 만료 세션 정리 기준 (ADMIN_SESSION_IDLE_MIN)
    IN i_max_hours           SMALLINT UNSIGNED     -- 세션 최대 수명(시간) (ADMIN_SESSION_MAX_HOURS)
) COMMENT 'GM 로그인 성공: 잠금·상태 재확인, 실패 횟수 초기화, 만료 세션 정리, 세션 발급'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_ADMIN_SESSION
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : 앱이 비밀번호를 확인한 뒤 부른다 (01_DESIGN 10.4, D-74).
    --        RESULT: 0 성공, 1001 파라미터, 1401 계정 없음·사용중지·비밀번호가 그 사이 바뀜, 1402 잠김 [codes.SpResult]
    --        성공 데이터: admin_session_id, expires_at
    --        - 앱의 확인(SP_GET_ADMIN_LOGIN → scrypt 비교)과 이 SP 사이에 다른 세션이 잠그거나, 사용중지하거나, 비밀번호를
    --          바꿀 수 있다(TOCTOU). 계정 행을 FOR UPDATE로 잠근 뒤 상태·잠금·해시를 다시 본다.
    --        - 사용중지와 해시 불일치는 "아이디 또는 비밀번호가 틀림"(1401)과 같은 코드로 돌려준다. 어느 쪽인지 알리지 않는다.
    --        - 그 계정의 만료 세션을 함께 지운다. 정리 잡을 따로 두지 않기 위해서다.
    --        - 잠금 순서: admin_account → admin_session (TABLE_LOCK_ORDER 14, 15).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)         DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_status           TINYINT UNSIGNED    DEFAULT NULL;
    DECLARE v_hash             VARCHAR(160)        DEFAULT NULL;
    DECLARE v_locked_until     DATETIME(3)         DEFAULT NULL;
    DECLARE v_expires_at       DATETIME(3);
    DECLARE v_session_id       BIGINT UNSIGNED;
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
        IF i_admin_account_id IS NULL OR i_admin_account_id = 0
           OR i_password_hash IS NULL OR i_password_hash = ''
           OR i_token_hash IS NULL OR LENGTH(i_token_hash) <> 32
           OR i_client_ip IS NULL
           OR i_idle_min IS NULL OR i_idle_min = 0
           OR i_max_hours IS NULL OR i_max_hours = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_expires_at = v_now + INTERVAL i_max_hours HOUR;

        START TRANSACTION;

        SELECT status, password_hash, locked_until INTO v_status, v_hash, v_locked_until
          FROM admin_account
         WHERE admin_account_id = i_admin_account_id
           FOR UPDATE;

        -- 테이블 콜레이션(ai_ci)은 대소문자를 무시한다. base64url 해시는 대소문자가 다르면 다른 값이라 바이트로 비교한다.
        IF v_status IS NULL OR v_status <> 1 OR CAST(v_hash AS BINARY) <> CAST(i_password_hash AS BINARY) THEN
            ROLLBACK;
            SELECT 1401 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_locked_until > v_now THEN
            ROLLBACK;
            SELECT 1402 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE admin_account
           SET fail_count = 0, locked_until = NULL
         WHERE admin_account_id = i_admin_account_id;

        DELETE FROM admin_session
         WHERE admin_account_id = i_admin_account_id
           AND (expires_at <= v_now OR last_seen_at <= v_now - INTERVAL i_idle_min MINUTE);

        INSERT INTO admin_session (admin_account_id, token_hash, created_at, last_seen_at, expires_at, client_ip)
        VALUES (i_admin_account_id, i_token_hash, v_now, v_now, v_expires_at, i_client_ip);
        SET v_session_id = LAST_INSERT_ID();

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT v_session_id AS admin_session_id, v_expires_at AS expires_at;
    END proc_block;
END$$
DELIMITER ;
