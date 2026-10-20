DROP PROCEDURE IF EXISTS `SP_LOG_PARTITION_ADD`;
DELIMITER $$
CREATE PROCEDURE `SP_LOG_PARTITION_ADD` (
    IN i_ahead_days    INT UNSIGNED    -- UTC 오늘부터 며칠 뒤까지 일 파티션을 만들지 (0~31)
) COMMENT 'log_ranking_submit 일 파티션을 p_max에서 떼어 UTC 오늘 + i_ahead_days까지 생성 (호출당 최대 64일, 멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LOG_PARTITION_ADD
    -- 작성 : 2026.10.04 trisakion
    -- 수정 : 2026.10.14 trisakion 재구성 전 p_max 행 여부(pmax_had_rows) 반환
    -- 수정 : 2026.10.14 trisakion 날짜 대신 일수를 받아 DB 시각(UTC_DATE)으로 계산
    -- 수정 : 2026.10.20 trisakion 첫 실행은 가장 오래된 행의 날짜부터 생성 (월 테이블 아카이브의 일 경계 보장)
    -- 내용 : 로그 정리 잡이 앞으로 며칠 치 일 파티션을 미리 만든다 (01_DESIGN 4.5).
    --        파티션 p_YYYYMMDD는 [그날 00:00, 다음날 00:00) UTC 범위다.
    --        - 파티션 이름과 경계는 DATE 값으로만 조립한다 (D-48). DATE_FORMAT 결과는 숫자와 '-'뿐이다.
    --        - 시작일은 마지막 일 파티션의 상한(= 다음 날)이다. 잡이 며칠 멈췄어도 빈 날짜 없이 이어서 만든다.
    --          일 파티션이 하나도 없으면(첫 실행) p_max에 있는 가장 오래된 행의 날짜부터 만든다(없으면 UTC 오늘).
    --          맨 앞 파티션은 하한이 없어 오늘부터 만들면 그 이전 행이 오늘 파티션에 섞이고, 월 테이블로 옮길 때
    --          (WITHOUT VALIDATION) 날짜와 다른 파티션에 놓인다. 첫 실행의 MIN은 p_max 전체를 읽지만 이어지는 재구성이
    --          어차피 모든 행을 복사한다.
    --        - 여러 날을 REORGANIZE 한 번으로 만든다. p_max에 행이 있으면 재구성이 그 행을 복사하므로,
    --          날마다 따로 실행하면 같은 행을 여러 번 복사한다. p_max에 행이 있다는 것 자체가 잡 이상 신호다 (11.4 알림).
    --        - 끝 날짜는 DB 시각으로 계산한다. created_at이 로그 DB 시각이므로 호스트 시계가 어긋나도 같은 기준이다.
    --        - 호출당 64일로 제한한다. 장기 중단 뒤에도 DDL 하나가 지나치게 커지지 않게 하며, 잡은 added_count가
    --          0이 될 때까지 다시 호출한다. i_ahead_days는 31일까지만 받는다(파티션 수 상한 8192 보호).
    --        - 경계는 PARTITION_DESCRIPTION('2026-10-06 00:00:00' 형태)에서 읽는다. 따옴표를 벗겨 DATETIME으로 바꾼다.
    --        - 재구성 전에 p_max에 행이 있었는지 pmax_had_rows로 돌려준다. 일 파티션이 있는데 p_max에 행이 있으면
    --          그날 파티션을 제때 만들지 못한 것이라 잡이 경고한다 (11.4). 재구성 뒤에는 행이 옮겨져 보이지 않으므로 먼저 본다.
    --          일 파티션이 없는 첫 실행은 원래 모든 행이 p_max에 있으므로 0으로 둔다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_until            DATE            DEFAULT UTC_DATE() + INTERVAL i_ahead_days DAY;
    DECLARE v_day              DATE;
    DECLARE v_pmax             TINYINT(1)      DEFAULT 0;
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
        IF i_ahead_days IS NULL OR i_ahead_days > 31 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_day = (SELECT DATE(CAST(TRIM(BOTH '''' FROM PARTITION_DESCRIPTION) AS DATETIME))
                       FROM information_schema.PARTITIONS
                      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit' AND PARTITION_NAME <> 'p_max'
                      ORDER BY PARTITION_ORDINAL_POSITION DESC
                      LIMIT 1);
        IF v_day IS NULL THEN
            SET v_day = LEAST(COALESCE((SELECT DATE(MIN(created_at)) FROM `log_ranking_submit`), UTC_DATE()), UTC_DATE());
        ELSE
            SET v_pmax = EXISTS(SELECT 1 FROM `log_ranking_submit` PARTITION (`p_max`));
        END IF;

        WHILE v_day <= v_until AND v_count < 64 DO
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
        SELECT v_count AS added_count, v_pmax AS pmax_had_rows;
    END proc_block;
END$$
DELIMITER ;
