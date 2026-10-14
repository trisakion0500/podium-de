DROP PROCEDURE IF EXISTS `SP_LOG_PARTITION_DROP`;
DELIMITER $$
CREATE PROCEDURE `SP_LOG_PARTITION_DROP` (
    IN i_retention_days    INT UNSIGNED    -- 보관 일수 (1 이상). UTC 오늘 - 이 일수보다 앞선 날의 일 파티션을 삭제
) COMMENT 'log_ranking_submit에서 보관 기간이 지난 일 파티션 삭제 (오래된 것부터 호출당 최대 31개, 멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LOG_PARTITION_DROP
    -- 작성 : 2026.10.04 trisakion
    -- 수정 : 2026.10.14 trisakion 날짜 대신 보관 일수를 받아 DB 시각(UTC_DATE)으로 계산, 0일 거부
    -- 내용 : 로그 정리 잡이 LOG_RETENTION_DAYS가 지난 일 파티션을 삭제한다 (01_DESIGN 4.5).
    --        잡은 i_retention_days = LOG_RETENTION_DAYS로 호출한다. 기준일은 UTC 오늘 - i_retention_days다.
    --        - 기준일은 DB 시각으로 계산한다. created_at이 로그 DB 시각이므로 호스트 시계가 어긋나도 같은 기준이다.
    --        - 0일은 거부한다. 오늘을 뺀 모든 로그가 지워지고 되돌릴 수 없다. "0 = 무제한"으로 잘못 넣는 경우를 막는다
    --          (앱 설정도 1 미만이면 기동을 막는다 — 이중 방어).
    --        - 로그 DB는 서비스 경로가 아니므로 데이터가 찬 파티션을 그대로 DROP한다 (운영 DB의 EXCHANGE 원칙과 다름).
    --        - 파티션 이름은 경계 DATE에서 다시 만든다(p_YYYYMMDD = 상한 - 1일). 사전의 이름 문자열을 그대로 붙이지 않는다 (D-48).
    --          이름과 경계가 어긋난 파티션이 있으면 DROP이 "없는 파티션"으로 실패해 50001이 되고, 잘못 지우지 않는다.
    --        - 한 번에 오래된 31개까지만 지운다. 목록을 GROUP_CONCAT으로 만드는데 group_concat_max_len(기본 1024)을
    --          넘으면 조용히 잘려 잘못된 DDL이 된다. 31개는 그 안에 들어간다. 잡은 dropped_count가 0이 될 때까지 다시 호출한다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_before_day       DATE            DEFAULT UTC_DATE() - INTERVAL i_retention_days DAY;
    DECLARE v_list             VARCHAR(1024);
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
        IF i_retention_days IS NULL OR i_retention_days < 1 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT GROUP_CONCAT(CONCAT('`p_', DATE_FORMAT(t.day, '%Y%m%d'), '`') ORDER BY t.day SEPARATOR ', '), COUNT(*)
          INTO v_list, v_count
          FROM (SELECT DATE(CAST(TRIM(BOTH '''' FROM PARTITION_DESCRIPTION) AS DATETIME)) - INTERVAL 1 DAY AS day
                  FROM information_schema.PARTITIONS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit' AND PARTITION_NAME <> 'p_max'
                 ORDER BY PARTITION_ORDINAL_POSITION
                 LIMIT 31) t
         WHERE t.day < v_before_day;

        IF v_count > 0 THEN
            CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `log_ranking_submit` DROP PARTITION ', v_list));
        END IF;

        SELECT 0 AS RESULT;
        SELECT v_count AS dropped_count;
    END proc_block;
END$$
DELIMITER ;
