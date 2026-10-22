DROP PROCEDURE IF EXISTS `SP_UPDATE_ADMIN_PASSWORD`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_ADMIN_PASSWORD` (
    IN i_requester_id    INT UNSIGNED,         -- 요청자 GM 계정 ID (본인 비밀번호만 바꾼다)
    IN i_old_hash        VARCHAR(160),         -- 앱이 현재 비밀번호 확인에 쓴 해시 (그 사이 바뀌었는지 확인)
    IN i_new_hash        VARCHAR(160),         -- 새 비밀번호 해시
    IN i_token_hash      VARBINARY(32),        -- 새로 발급할 세션 토큰 SHA-256 해시
    IN i_client_ip       VARCHAR(45),          -- 요청 IP
    IN i_max_hours       SMALLINT UNSIGNED     -- 세션 최대 수명(시간) (ADMIN_SESSION_MAX_HOURS)
) COMMENT 'GM 본인 비밀번호 변경: 기존 세션 모두 삭제, 새 세션 1개 발급'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_ADMIN_PASSWORD
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : POST /admin/v1/auth/password (01_DESIGN 10.4, D-74). 현재 비밀번호 비교(scrypt)는 앱이 먼저 한다.
    --        RESULT: 0 성공, 1001 파라미터, 1401 현재 비밀번호가 그 사이 바뀜, 1402 잠김, 1405 사용중지 [codes.SpResult]
    --        성공 데이터: admin_session_id, expires_at (새 세션)
    --        - 비밀번호가 바뀌면 그 계정의 세션을 모두 지운다(다른 곳에서 열린 세션 포함). 요청한 화면은 새 세션으로 계속 쓴다.
    --        - 앱의 확인과 이 SP 사이에 다른 변경·초기화가 끼어들 수 있다(TOCTOU). 계정 행을 잠근 뒤 해시를 다시 본다.
    --        - 잠긴 계정은 거부한다(1402). 앱도 비교 전에 막지만, 앱이 놓쳐도 잠금 중 대입으로 비밀번호가 바뀌지 않게 한다.
    --        - 초기 비밀번호 변경 요구(must_change_password)를 여기서 푼다.
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
        IF i_requester_id IS NULL OR i_requester_id = 0
           OR i_old_hash IS NULL OR i_old_hash = '' OR i_new_hash IS NULL OR i_new_hash = ''
           OR i_token_hash IS NULL OR LENGTH(i_token_hash) <> 32
           OR i_client_ip IS NULL OR i_max_hours IS NULL OR i_max_hours = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_expires_at = v_now + INTERVAL i_max_hours HOUR;

        START TRANSACTION;

        SELECT status, password_hash, locked_until INTO v_status, v_hash, v_locked_until
          FROM admin_account
         WHERE admin_account_id = i_requester_id
           FOR UPDATE;

        IF v_status IS NULL OR v_status <> 1 THEN
            ROLLBACK;
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_locked_until > v_now THEN
            ROLLBACK;
            SELECT 1402 AS RESULT;
            LEAVE proc_block;
        END IF;
        -- 테이블 콜레이션(ai_ci)은 대소문자를 무시하므로 바이트로 비교한다.
        IF CAST(v_hash AS BINARY) <> CAST(i_old_hash AS BINARY) THEN
            ROLLBACK;
            SELECT 1401 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE admin_account
           SET password_hash = i_new_hash, must_change_password = 0, password_changed_at = v_now,
               updated_at = v_now, updated_by = i_requester_id
         WHERE admin_account_id = i_requester_id;

        DELETE FROM admin_session WHERE admin_account_id = i_requester_id;

        INSERT INTO admin_session (admin_account_id, token_hash, created_at, last_seen_at, expires_at, client_ip)
        VALUES (i_requester_id, i_token_hash, v_now, v_now, v_expires_at, i_client_ip);
        SET v_session_id = LAST_INSERT_ID();

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT v_session_id AS admin_session_id, v_expires_at AS expires_at;
    END proc_block;
END$$
DELIMITER ;
