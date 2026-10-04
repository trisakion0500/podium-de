DROP PROCEDURE IF EXISTS `SP_LOG_PARTITION_ADD`;
DELIMITER $$
CREATE PROCEDURE `SP_LOG_PARTITION_ADD` (
    IN i_until_day    DATE    -- 이 날짜(UTC)까지 일 파티션을 만든다 (UTC 오늘 + 31일 이내)
) COMMENT 'log_ranking_submit 일 파티션을 p_max에서 떼어 i_until_day까지 생성 (호출당 최대 64일, 멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LOG_PARTITION_ADD
    -- 작성 : 2026.10.04 trisakion
    -- 내용 : 로그 정리 잡이 매일 다음 며칠 치 일 파티션을 미리 만든다 (01_DESIGN 4.5).
    --        파티션 p_YYYYMMDD는 [그날 00:00, 다음날 00:00) UTC 범위다.
    --        - 파티션 이름과 경계는 DATE 값으로만 조립한다 (D-48). DATE_FORMAT 결과는 숫자와 '-'뿐이다.
    --        - 시작일은 마지막 일 파티션의 상한(= 다음 날)이다. 잡이 며칠 멈췄어도 빈 날짜 없이 이어서 만든다.
    --          일 파티션이 하나도 없으면(첫 실행) UTC 오늘부터 만든다. 이때 첫 파티션에는 그 이전 행도 함께 들어간다.
    --        - 여러 날을 REORGANIZE 한 번으로 만든다. p_max에 행이 있으면 재구성이 그 행을 복사하므로,
    --          날마다 따로 실행하면 같은 행을 여러 번 복사한다. p_max에 행이 있다는 것 자체가 잡 이상 신호다 (11.4 알림).
    --        - 호출당 64일로 제한한다. 장기 중단 뒤에도 DDL 하나가 지나치게 커지지 않게 하며, 잡은 added_count가
    --          0이 될 때까지 다시 호출한다. i_until_day는 오늘 + 31일까지만 받는다(파티션 수 상한 8192 보호).
    --        - 경계는 PARTITION_DESCRIPTION('2026-10-06 00:00:00' 형태)에서 읽는다. 따옴표를 벗겨 DATETIME으로 바꾼다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_day              DATE;
    DECLARE v_defs             VARCHAR(8192)   DEFAULT '';
    DECLARE v_count            INT UNSIGNED    DEFAULT 0;
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
        IF i_until_day IS NULL OR i_until_day > UTC_DATE() + INTERVAL 31 DAY THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_day = (SELECT DATE(CAST(TRIM(BOTH '''' FROM PARTITION_DESCRIPTION) AS DATETIME))
                       FROM information_schema.PARTITIONS
                      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit' AND PARTITION_NAME <> 'p_max'
                      ORDER BY PARTITION_ORDINAL_POSITION DESC
                      LIMIT 1);
        IF v_day IS NULL THEN
            SET v_day = UTC_DATE();
        END IF;

        WHILE v_day <= i_until_day AND v_count < 64 DO
            SET v_defs = CONCAT(v_defs, 'PARTITION `p_', DATE_FORMAT(v_day, '%Y%m%d'),
                                '` VALUES LESS THAN (''', DATE_FORMAT(v_day + INTERVAL 1 DAY, '%Y-%m-%d'), ' 00:00:00''), ');
            SET v_day = v_day + INTERVAL 1 DAY;
            SET v_count = v_count + 1;
        END WHILE;

        IF v_count > 0 THEN
            CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `log_ranking_submit` REORGANIZE PARTITION `p_max` INTO (',
                                    v_defs, 'PARTITION `p_max` VALUES LESS THAN (MAXVALUE))'));
        END IF;

        SELECT 0 AS RESULT;
        SELECT v_count AS added_count;
    END proc_block;
END$$
DELIMITER ;
