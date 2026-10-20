DROP PROCEDURE IF EXISTS `SP_LOG_ARCHIVE_DROP`;
DELIMITER $$
CREATE PROCEDURE `SP_LOG_ARCHIVE_DROP` (
    IN i_archive_months    INT UNSIGNED    -- 월 테이블 보관 개월 수 (1 이상). 끝난 지 이 개월 수가 지난 달의 월 테이블을 삭제
) COMMENT '보관 기간(LOG_ARCHIVE_MONTHS)이 지난 가장 오래된 월 테이블 log_ranking_submit_YYYYMM 하나 삭제 (멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LOG_ARCHIVE_DROP
    -- 작성 : 2026.10.20 trisakion
    -- 내용 : 로그 정리 잡이 LOG_ARCHIVE_MONTHS가 지난 월 테이블을 지운다 (01_DESIGN 4.5).
    --        - 기준은 데이터 날짜다. 그 달의 마지막 날 다음 날(= 다음 달 1일)이 UTC 오늘 - i_archive_months개월 이하이면 지운다.
    --          = 그 달 1일 < (UTC 오늘 - i_archive_months개월)이 속한 달의 1일. 예) 12개월, 오늘 2026-10-16 → 202509 이전 삭제.
    --          월 단위라 데이터는 최대 한 달 더 남는다.
    --        - 0개월은 거부한다. 옮기자마자 지우게 되어 되돌릴 수 없다 (앱 설정도 1 미만이면 기동을 막는다 — 이중 방어).
    --        - 대상은 이름이 log_ranking_submit_ + YYYYMM(01~12월)인 테이블뿐이다. 이름은 읽은 값에서 날짜로 바꾼 뒤 그 DATE로
    --          다시 만든다 (D-48).
    --        - 목록 조회 안에서는 날짜로 바꾸지 않고 YYYYMM 문자열로 비교한다. 옵티마이저가 REGEXP 거르기보다 먼저 변환식을
    --          다른 테이블 이름(log_ddl_audit 등)에 적용하면 strict 모드에서 1411 오류가 난다. 변환은 고른 한 값에만 따로 한다.
    --          운영자가 이름을 바꿔 둔 테이블(…_202509_keep 등)도 대상이 아니다.
    --        - 데이터가 찬 테이블을 그대로 DROP한다. 락은 그 월 테이블에만 걸리고 운영 테이블의 INSERT는 막히지 않는다.
    --          큰 파일 삭제가 길 수 있어 호출당 하나만 지운다. 잡은 dropped_count가 0이 될 때까지 다시 호출한다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_cutoff           DATE            DEFAULT DATE_FORMAT(UTC_DATE() - INTERVAL i_archive_months MONTH, '%Y-%m-01');
    DECLARE v_ym               CHAR(6);
    DECLARE v_month            DATE;
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
        IF i_archive_months IS NULL OR i_archive_months < 1 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_ym = (SELECT MIN(RIGHT(TABLE_NAME, 6))
                      FROM information_schema.TABLES
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME REGEXP '^log_ranking_submit_[0-9]{4}(0[1-9]|1[0-2])$'
                       AND RIGHT(TABLE_NAME, 6) < DATE_FORMAT(v_cutoff, '%Y%m'));
        IF v_ym IS NULL THEN
            SELECT 0 AS RESULT;
            SELECT 0 AS dropped_count;
            LEAVE proc_block;
        END IF;

        SET v_month = CAST(CONCAT(LEFT(v_ym, 4), '-', RIGHT(v_ym, 2), '-01') AS DATE);
        CALL SP_EXEC_DDL(CONCAT('DROP TABLE `log_ranking_submit_', DATE_FORMAT(v_month, '%Y%m'), '`'));

        SELECT 0 AS RESULT;
        SELECT 1 AS dropped_count;
    END proc_block;
END$$
DELIMITER ;
