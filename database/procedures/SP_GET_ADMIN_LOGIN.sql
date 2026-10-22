DROP PROCEDURE IF EXISTS `SP_GET_ADMIN_LOGIN`;
DELIMITER $$
CREATE PROCEDURE `SP_GET_ADMIN_LOGIN` (
    IN i_login_id    VARCHAR(64)    -- 로그인 아이디
) COMMENT '로그인 확인용 GM 계정 조회 (해시·상태·잠금, 없으면 빈 결과)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_GET_ADMIN_LOGIN
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : 로그인과 비밀번호 변경 때 앱이 부른다 (01_DESIGN 10.4). 비밀번호 비교(scrypt)는 앱이 한다 — MySQL에 scrypt가 없다.
    --        RESULT: 0 성공 (계정이 없으면 데이터 0행) [codes.SpResult]
    --        - 없는 아이디도 RESULT 0이다. 앱이 더미 해시로 비교해 응답 시간과 응답 코드를 같게 맞춘다(아이디 존재를 알리지 않음).
    --        - role은 FN_GET_ADMIN_ROLE과 같은 규칙으로 알 수 없는 값을 1(VIEWER)로 바꿔 돌려준다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다. 실제 상태 확인은 세션 발급 SP가 잠근 뒤 다시 한다.
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

    SELECT 0 AS RESULT;
    SELECT admin_account_id, login_id, display_name,
           IF(role IN (1, 2, 3), role, 1) AS role,
           status, password_hash, must_change_password,
           IF(locked_until > UTC_TIMESTAMP(3), 1, 0) AS locked
      FROM admin_account
     WHERE login_id = i_login_id;
END$$
DELIMITER ;
