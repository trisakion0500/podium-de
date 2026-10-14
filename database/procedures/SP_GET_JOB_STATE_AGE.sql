DROP PROCEDURE IF EXISTS `SP_GET_JOB_STATE_AGE`;
DELIMITER $$
CREATE PROCEDURE `SP_GET_JOB_STATE_AGE` (
    IN i_job_name      VARCHAR(64),     -- 잡 이름 (예: log_cleanup)
    IN i_ranking_id    INT UNSIGNED,    -- 대상 랭킹 ID (0:랭킹 무관)
    IN i_season_no     INT UNSIGNED     -- 대상 시즌 번호 (0:시즌 무관)
) COMMENT '잡 마지막 실행 후 지난 초 (정리 잡 정체 감시용, DB 시각 기준)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_GET_JOB_STATE_AGE
    -- 작성 : 2026.10.14 trisakion
    -- 내용 : 정리 잡이 조용히 멈췄는지 다른 잡이 확인한다 (01_DESIGN 11.4 보관 정리 감시).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: age_sec (행이 없거나 last_run_at이 NULL이면 NULL — 한 번도 성공하지 않음)
    --
    --        - 경과 시간은 DB 시각으로 계산한다. last_run_at도 DB 시각이라(SP_UPSERT_JOB_STATE) 호스트마다 시계가
    --          달라도 판정이 틀어지지 않는다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_last_run_at      DATETIME(3);
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
        IF i_job_name IS NULL OR i_job_name = '' OR i_ranking_id IS NULL OR i_season_no IS NULL THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT last_run_at
          INTO v_last_run_at
          FROM job_state
         WHERE job_name = i_job_name AND ranking_id = i_ranking_id AND season_no = i_season_no;

        SELECT 0 AS RESULT;
        SELECT TIMESTAMPDIFF(SECOND, v_last_run_at, UTC_TIMESTAMP(3)) AS age_sec;
    END proc_block;
END$$
DELIMITER ;
