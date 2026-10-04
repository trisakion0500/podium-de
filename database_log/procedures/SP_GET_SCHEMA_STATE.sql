DROP PROCEDURE IF EXISTS `SP_GET_SCHEMA_STATE`;
DELIMITER $$
CREATE PROCEDURE `SP_GET_SCHEMA_STATE` () COMMENT '마이그레이션 적용 기록(스크립트 경로, 체크섬) 조회 — 기동 시 스키마 확인용'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_GET_SCHEMA_STATE
    -- 작성 : 2026.10.04 trisakion
    -- 내용 : 기동 시 패키지의 SQL 파일 목록·체크섬과 DB 적용 기록을 비교하는 데 쓴다 (01_DESIGN 11.5, migrate.ts).
    --        앱 계정은 EXECUTE만 있어 schema_migration을 직접 읽지 못하므로 DEFINER 권한으로 읽어 준다.
    --        schema_migration은 러너가 SP보다 먼저 만들므로 이 SP가 있으면 테이블도 있다.
    --        로그 DB용이다. 메인 DB에도 같은 이름·본문의 SP가 있다 (각 DB의 schema_migration을 읽는다).
    --        RESULT 0을 내보낸 뒤 데이터 SELECT가 실패하면 핸들러의 50001이 두 번째 결과셋으로 나가 호출부가 성공으로
    --        오인한다. 그래서 테이블 접근을 RESULT보다 먼저 한 번 확인한다.
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

    DO (SELECT 1 FROM schema_migration LIMIT 1);
    SELECT 0 AS RESULT;
    SELECT script_name, checksum
      FROM schema_migration
     ORDER BY script_name;
END$$
DELIMITER ;
