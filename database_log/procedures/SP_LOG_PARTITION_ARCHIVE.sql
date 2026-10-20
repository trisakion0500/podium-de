DROP PROCEDURE IF EXISTS `SP_LOG_PARTITION_ARCHIVE`;
DELIMITER $$
CREATE PROCEDURE `SP_LOG_PARTITION_ARCHIVE` (
    IN i_retention_days    INT UNSIGNED    -- 보관 일수 (1 이상). UTC 오늘 - 이 일수보다 앞선 날의 일 파티션을 월 테이블로 옮김
) COMMENT 'log_ranking_submit에서 보관 기간이 지난 가장 오래된 일 파티션 하나를 월 테이블 log_ranking_submit_YYYYMM으로 옮김 (EXCHANGE 두 번, 멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LOG_PARTITION_ARCHIVE
    -- 작성 : 2026.10.20 trisakion
    -- 내용 : 로그 정리 잡이 LOG_RETENTION_DAYS가 지난 일 파티션을 지우지 않고 월 테이블로 옮긴다 (01_DESIGN 4.5).
    --        호출당 하루만 옮긴다. 잡은 archived_count가 0이 될 때까지 다시 호출한다.
    --        - 옮기기: 운영 일 파티션 → 빈 교환 테이블(log_ranking_submit_xchg) → 월 테이블의 같은 날 파티션 → 빈 운영 파티션 DROP.
    --          행을 복사하지 않으므로 크기와 무관하게 바로 끝난다. 운영 테이블에 걸리는 것은 메타데이터 수준의 배타 MDL뿐이다.
    --        - 월 테이블은 운영 테이블을 LIKE로 복사한 뒤 그 달의 일 파티션으로 다시 나눈다. 구조와 일 경계가 같으므로
    --          두 번째 교환은 WITHOUT VALIDATION으로 한다(검증은 하루 치 행을 모두 읽는다). 첫 교환은 비어 있는 교환 테이블만
    --          검증하므로 기본값(WITH VALIDATION)으로 둔다.
    --        - 교환 테이블은 쓸 때마다 운영 테이블에서 새로 만들고 다 쓰면 지운다. 남겨 두면 운영 테이블 스키마가 바뀐 뒤
    --          구조가 달라 첫 교환이 실패한다.
    --        - 재실행 안전성: 교환은 맞바꾸기라 같은 교환을 다시 하면 데이터가 되돌아간다. 상태를 보고 다음 단계만 한다.
    --            교환 테이블에 행이 있음  → 첫 교환 뒤 끊긴 것. 행의 날짜로 월 테이블 교환부터 이어서 한다.
    --            교환 테이블이 비어 있음  → 두 번째 교환 뒤 또는 만든 직후 끊긴 것. 지우고 처음부터 본다.
    --            운영 파티션이 비어 있음  → 교환 없이 파티션만 지운다(옮긴 뒤 끊긴 경우, 행이 없던 날).
    --        - 두 번째 교환 뒤 교환 테이블에 행이 있으면 월 테이블의 그날 파티션이 비어 있지 않았던 것이다(사람이 건드린 경우).
    --          지우지 않고 오류로 멈춘다. 데이터는 교환 테이블이나 월 테이블에 남는다.
    --        - 운영 파티션의 빈 여부는 날짜 범위로 본다. 파티션 키 조건이라 그 파티션만 읽는다. 맨 앞 파티션은 하한이 없으므로
    --          "다음 날 0시 미만" 조건으로 본다.
    --        - 이름은 DATE 값으로만 조립한다 (D-48). 운영 파티션 이름은 경계에서 다시 만든다(p_YYYYMMDD = 상한 - 1일).
    --        - 운영 테이블 스키마가 바뀌어 월 테이블과 구조가 다르면 두 번째 교환이 실패해 50001이 된다. 데이터는 교환 테이블에
    --          남고, 운영자가 월 테이블 구조를 맞추거나 이름을 바꾸면 다음 호출이 이어서 한다 (05_TROUBLESHOOTING).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_before_day       DATE            DEFAULT UTC_DATE() - INTERVAL i_retention_days DAY;
    DECLARE v_day              DATE;
    DECLARE v_month            VARCHAR(64);
    DECLARE v_partition        VARCHAR(64);
    DECLARE v_defs             VARCHAR(4096)   DEFAULT '';
    DECLARE v_d                DATE;
    DECLARE v_resume           TINYINT(1)      DEFAULT 0;
    DECLARE v_move             TINYINT(1)      DEFAULT 0;
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

        IF EXISTS (SELECT 1 FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit_xchg') THEN
            IF EXISTS (SELECT 1 FROM `log_ranking_submit_xchg`) THEN
                SET v_day = (SELECT DATE(created_at) FROM `log_ranking_submit_xchg` LIMIT 1);
                SET v_resume = 1;
            ELSE
                CALL SP_EXEC_DDL('DROP TABLE `log_ranking_submit_xchg`');
            END IF;
        END IF;

        IF v_resume = 0 THEN
            SET v_day = (SELECT DATE(CAST(TRIM(BOTH '''' FROM PARTITION_DESCRIPTION) AS DATETIME)) - INTERVAL 1 DAY
                           FROM information_schema.PARTITIONS
                          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit' AND PARTITION_NAME <> 'p_max'
                          ORDER BY PARTITION_ORDINAL_POSITION
                          LIMIT 1);
            IF v_day IS NULL OR v_day >= v_before_day THEN
                SELECT 0 AS RESULT;
                SELECT 0 AS archived_count;
                LEAVE proc_block;
            END IF;
            SET v_move = EXISTS (SELECT 1 FROM `log_ranking_submit` WHERE created_at < v_day + INTERVAL 1 DAY);
        END IF;

        SET v_partition = CONCAT('p_', DATE_FORMAT(v_day, '%Y%m%d'));

        IF v_move = 1 THEN
            CALL SP_EXEC_DDL('CREATE TABLE `log_ranking_submit_xchg` LIKE `log_ranking_submit`');
            CALL SP_EXEC_DDL('ALTER TABLE `log_ranking_submit_xchg` REMOVE PARTITIONING');
            CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `log_ranking_submit` EXCHANGE PARTITION `', v_partition, '` WITH TABLE `log_ranking_submit_xchg`'));
        END IF;

        IF v_resume = 1 OR v_move = 1 THEN
            SET v_month = CONCAT('log_ranking_submit_', DATE_FORMAT(v_day, '%Y%m'));
            IF NOT EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = v_month) THEN
                SET v_d = DATE_FORMAT(v_day, '%Y-%m-01');
                WHILE v_d <= LAST_DAY(v_day) DO
                    SET v_defs = CONCAT(v_defs, IF(v_defs = '', '', ', '), 'PARTITION `p_', DATE_FORMAT(v_d, '%Y%m%d'),
                                        '` VALUES LESS THAN (''', DATE_FORMAT(v_d + INTERVAL 1 DAY, '%Y-%m-%d'), ' 00:00:00'')');
                    SET v_d = v_d + INTERVAL 1 DAY;
                END WHILE;
                -- LIKE는 운영 테이블의 파티션 정의까지 복사하므로 그 달의 일 파티션으로 다시 나눈다. 빈 테이블이라 즉시 끝난다.
                -- 두 DDL 사이에 끊기면 다음 호출은 테이블이 있다고 보고 교환한다. 그날 파티션이 없으면 50001로 멈춘다(사람 확인).
                CALL SP_EXEC_DDL(CONCAT('CREATE TABLE `', v_month, '` LIKE `log_ranking_submit`'));
                CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `', v_month, '` PARTITION BY RANGE COLUMNS (`created_at`) (', v_defs, ')'));
            END IF;
            CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `', v_month, '` EXCHANGE PARTITION `', v_partition,
                                    '` WITH TABLE `log_ranking_submit_xchg` WITHOUT VALIDATION'));
            IF EXISTS (SELECT 1 FROM `log_ranking_submit_xchg`) THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SP_LOG_PARTITION_ARCHIVE: month table partition was not empty';
            END IF;
            CALL SP_EXEC_DDL('DROP TABLE `log_ranking_submit_xchg`');
        END IF;

        -- 이어서 한 경우에도 운영 파티션이 남아 있을 수 있다. 비어 있을 때만 지운다(방어적 이중 체크).
        IF EXISTS (SELECT 1 FROM information_schema.PARTITIONS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit' AND PARTITION_NAME = v_partition) THEN
            IF EXISTS (SELECT 1 FROM `log_ranking_submit` WHERE created_at < v_day + INTERVAL 1 DAY) THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SP_LOG_PARTITION_ARCHIVE: day partition not empty after exchange';
            END IF;
            CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `log_ranking_submit` DROP PARTITION `', v_partition, '`'));
        END IF;

        SELECT 0 AS RESULT;
        SELECT 1 AS archived_count;
    END proc_block;
END$$
DELIMITER ;
