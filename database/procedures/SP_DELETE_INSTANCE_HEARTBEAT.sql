DROP PROCEDURE IF EXISTS `SP_DELETE_INSTANCE_HEARTBEAT`;
DELIMITER $$
CREATE PROCEDURE `SP_DELETE_INSTANCE_HEARTBEAT` (
    IN i_instance_id    CHAR(36)    -- 인스턴스 ID (자기 자신)
) COMMENT '정상 종료 시 자기 하트비트 행 삭제 (없으면 성공)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_DELETE_INSTANCE_HEARTBEAT
    -- 작성 : 2026.10.04 trisakion
    -- 내용 : 정상 종료 훅이 호출한다 (01_DESIGN 11.4). 삭제하지 않으면 유효 시간(30초) 동안 migrate가 거부된다.
    --        행이 이미 없어도 성공이다. 종료 재시도나 정리 후 호출에도 결과가 같아야 한다.
    -- ------------------------------------------------------------------------------------------------------------ --
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
        IF i_instance_id IS NULL OR CHAR_LENGTH(i_instance_id) <> 36 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        DELETE FROM instance_heartbeat WHERE instance_id = i_instance_id;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
