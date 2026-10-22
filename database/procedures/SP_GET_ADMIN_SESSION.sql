DROP PROCEDURE IF EXISTS `SP_GET_ADMIN_SESSION`;
DELIMITER $$
CREATE PROCEDURE `SP_GET_ADMIN_SESSION` (
    IN i_token_hash    VARBINARY(32),        -- 쿠키 토큰의 SHA-256 해시
    IN i_idle_min      SMALLINT UNSIGNED     -- 유휴 만료(분) (ADMIN_SESSION_IDLE_MIN)
) COMMENT 'GM 세션 확인: 만료·사용중지면 삭제, 유효하면 1분 단위로 last_seen_at 갱신 후 계정 반환'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_GET_ADMIN_SESSION
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : 관리 API 인증 가드가 요청마다 부른다 (01_DESIGN 10.4, D-74).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: 유효하면 1행(admin_session_id, admin_account_id, login_id, display_name, role, must_change_password),
    --                     세션이 없거나 만료·사용중지면 0행 — 앱이 2002로 응답한다
    --        - 만료(유휴, 최대 수명)와 사용중지 계정의 세션은 여기서 지운다. 다시 와도 같은 결과지만 행이 남지 않게 한다.
    --        - last_seen_at은 1분이 지났을 때만 쓴다. 요청마다 쓰면 관리 화면의 연속 요청이 같은 행을 계속 잠근다.
    --          그래서 유휴 만료는 최대 1분 늦다.
    --        - 역할은 세션에 두지 않고 계정 행에서 읽는다. 역할 변경이 다음 요청부터 적용된다.
    --        - 쓰기는 admin_session 한 행의 DELETE 또는 UPDATE 하나라 자동 커밋으로 끝낸다. 계정 행은 잠그지 않는다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)         DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_session_id       BIGINT UNSIGNED     DEFAULT NULL;
    DECLARE v_last_seen_at     DATETIME(3);
    DECLARE v_expires_at       DATETIME(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_valid            TINYINT             DEFAULT 0;
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
        IF i_token_hash IS NULL OR LENGTH(i_token_hash) <> 32 OR i_idle_min IS NULL OR i_idle_min = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT s.admin_session_id, s.last_seen_at, s.expires_at, a.status
          INTO v_session_id, v_last_seen_at, v_expires_at, v_status
          FROM admin_session s
          JOIN admin_account a ON a.admin_account_id = s.admin_account_id
         WHERE s.token_hash = i_token_hash;

        IF v_session_id IS NOT NULL THEN
            IF v_status <> 1 OR v_expires_at <= v_now OR v_last_seen_at <= v_now - INTERVAL i_idle_min MINUTE THEN
                DELETE FROM admin_session WHERE admin_session_id = v_session_id;
            ELSE
                SET v_valid = 1;
                IF v_last_seen_at <= v_now - INTERVAL 1 MINUTE THEN
                    UPDATE admin_session SET last_seen_at = v_now WHERE admin_session_id = v_session_id;
                END IF;
            END IF;
        END IF;

        SELECT 0 AS RESULT;
        SELECT s.admin_session_id, a.admin_account_id, a.login_id, a.display_name,
               IF(a.role IN (1, 2, 3), a.role, 1) AS role, a.must_change_password
          FROM admin_session s
          JOIN admin_account a ON a.admin_account_id = s.admin_account_id
         WHERE s.admin_session_id = v_session_id AND v_valid = 1;
    END proc_block;
END$$
DELIMITER ;
