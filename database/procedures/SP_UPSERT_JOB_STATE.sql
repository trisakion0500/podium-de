DROP PROCEDURE IF EXISTS `SP_UPSERT_JOB_STATE`;
DELIMITER $$
CREATE PROCEDURE `SP_UPSERT_JOB_STATE` (
    IN i_job_name      VARCHAR(64),     -- 잡 이름 (예: reconciler, recovery_audit)
    IN i_ranking_id    INT UNSIGNED,    -- 대상 랭킹 ID (0:랭킹 무관)
    IN i_season_no     INT UNSIGNED,    -- 대상 시즌 번호 (0:시즌 무관)
    IN i_synced_at     DATETIME(3)      -- 동기화 시각 (NULL:동기화 시각 없는 잡, 기존 값 유지)
) COMMENT '잡 진행 상태 기록: 동기화 시각은 뒤로 가지 않음, last_run_at은 DB 시각'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPSERT_JOB_STATE
    -- 작성 : 2026.10.09 trisakion
    -- 내용 : 복구 잡이 시즌별 리컨실러 동기화 시각과 보조 점검 시각을 남긴다 (01_DESIGN 6.2, 6.4, 11.4).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --
    --        - 동기화 시각은 GREATEST로 앞으로만 간다. 락을 잃은 워커가 늦게 오래된 T를 써도 되돌아가
    --          정산 시작 조건(7.1)이 거짓으로 풀렸다 잠기지 않는다.
    --        - last_run_at, updated_at은 DB 시각이다. 보조 점검 주기 판단을 DB 시각으로 하기 위해서다.
    --        - 단독 자동 커밋 한 문장이다. job_state는 잠금 순서 10번이며 다른 테이블과 같은 트랜잭션에 묶이지 않는다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT NOW(3);
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

        INSERT INTO job_state (job_name, ranking_id, season_no, synced_at, last_run_at, updated_at)
        VALUES (i_job_name, i_ranking_id, i_season_no, i_synced_at, v_now, v_now) AS n
        ON DUPLICATE KEY UPDATE
            synced_at   = CASE
                              WHEN n.synced_at IS NULL THEN job_state.synced_at
                              WHEN job_state.synced_at IS NULL THEN n.synced_at
                              ELSE GREATEST(job_state.synced_at, n.synced_at)
                          END,
            last_run_at = n.last_run_at,
            updated_at  = n.updated_at;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
