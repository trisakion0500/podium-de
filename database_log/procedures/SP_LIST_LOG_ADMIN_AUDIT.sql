DROP PROCEDURE IF EXISTS `SP_LIST_LOG_ADMIN_AUDIT`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_LOG_ADMIN_AUDIT` (
    IN i_offset              INT UNSIGNED,         -- 시작 위치 (0부터)
    IN i_size                SMALLINT UNSIGNED,    -- 최대 행 수 (1~100)
    IN i_admin_account_id    INT UNSIGNED,         -- 실행자 계정 ID 필터 (NULL:전체)
    IN i_action              VARCHAR(64)           -- 조작 필터 (NULL:전체, 정확히 일치)
) COMMENT 'GM 조작 감사 로그 페이징 (최신순)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_LOG_ADMIN_AUDIT
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : GET /admin/v1/audit (01_DESIGN 10.4). 로그 DB는 메인 DB 계정을 볼 수 없어 역할 확인(ADMIN)은 앱만 한다
    --        (개발 컨벤션 4.2의 로그 DB 예외).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: 감사 행과 total_count. 범위 밖이면 total_count만 채운 1행 — 개발 컨벤션 4.6의 LEFT JOIN ON TRUE
    --        - 최신순은 PK 역순이다. 추가 전용이라 PK 순서가 기록 순서다.
    --        - 계정 필터는 ix_admin_account_id_created_at을 탄다. 조작 필터는 인덱스가 없다 — 건수가 적은 테이블이라 둔다.
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
        IF i_offset IS NULL OR i_size IS NULL OR i_size = 0 OR i_size > 100 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT p.log_admin_audit_id, p.admin_account_id, p.login_id, p.role, p.action, p.target_type, p.target_id,
               p.result_code, p.before_json, p.after_json, p.request_id, p.client_ip, p.created_at, cnt.total_count
          FROM (
                SELECT COUNT(log_admin_audit_id) AS total_count
                  FROM log_admin_audit
                 WHERE (i_admin_account_id IS NULL OR admin_account_id = i_admin_account_id)
                   AND (i_action IS NULL OR action = i_action)
          ) cnt
          LEFT JOIN (
                SELECT log_admin_audit_id, admin_account_id, login_id, role, action, target_type, target_id,
                       result_code, before_json, after_json, request_id, client_ip, created_at
                  FROM log_admin_audit
                 WHERE (i_admin_account_id IS NULL OR admin_account_id = i_admin_account_id)
                   AND (i_action IS NULL OR action = i_action)
                 ORDER BY log_admin_audit_id DESC
                 LIMIT i_size OFFSET i_offset
          ) p ON TRUE
         ORDER BY p.log_admin_audit_id DESC;
    END proc_block;
END$$
DELIMITER ;
