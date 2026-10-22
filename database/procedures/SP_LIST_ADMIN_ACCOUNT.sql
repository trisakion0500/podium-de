DROP PROCEDURE IF EXISTS `SP_LIST_ADMIN_ACCOUNT`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_ADMIN_ACCOUNT` (
    IN i_offset    INT UNSIGNED,         -- 시작 위치 (0부터)
    IN i_size      SMALLINT UNSIGNED     -- 최대 행 수 (1~100)
) COMMENT 'GM 계정 목록 페이징 (ID순, 해시 제외)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_ADMIN_ACCOUNT
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : GET /admin/v1/accounts (01_DESIGN 10.4). 역할 확인(ADMIN)은 앱이 한다 — 상태를 바꾸지 않는 조회라서다.
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: 계정 행과 total_count. 범위 밖이면 total_count만 채운 1행 — 개발 컨벤션 4.6의 LEFT JOIN ON TRUE
    --        - password_hash는 돌려주지 않는다.
    --        - 계정 수는 적어 OFFSET으로 충분하다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
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
        SELECT p.admin_account_id, p.login_id, p.display_name, p.role, p.status, p.must_change_password,
               p.locked, p.password_changed_at, p.created_at, p.updated_at, cnt.total_count
          FROM (SELECT COUNT(admin_account_id) AS total_count FROM admin_account) cnt
          LEFT JOIN (
                SELECT admin_account_id, login_id, display_name, role, status, must_change_password,
                       IF(locked_until > v_now, 1, 0) AS locked, password_changed_at, created_at, updated_at
                  FROM admin_account
                 ORDER BY admin_account_id
                 LIMIT i_size OFFSET i_offset
          ) p ON TRUE
         ORDER BY p.admin_account_id;
    END proc_block;
END$$
DELIMITER ;
