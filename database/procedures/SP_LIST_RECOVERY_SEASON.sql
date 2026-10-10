DROP PROCEDURE IF EXISTS `SP_LIST_RECOVERY_SEASON`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_RECOVERY_SEASON` (
) COMMENT '복구 잡 대상 시즌 목록 (시작 60초 전부터, CLOSED 이하)과 동기화 시각·점검 시각·DB 시각'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_RECOVERY_SEASON
    -- 작성 : 2026.10.09 trisakion
    -- 수정 : 2026.10.10 trisakion NOW(3) → UTC_TIMESTAMP(3) (호출 세션 time_zone과 무관하게 UTC, D-66)
    -- 내용 : 워커 복구 잡(01_DESIGN 6.2~6.4, D-60)이 주기마다 처음 부른다.
    --        - 대상은 상태가 아니라 시각으로 고른다. 제출이 [start_at, end_at) 시각으로 받으므로(3.5) 상태 전이 잡이
    --          늦어도 제출이 들어가는 시즌이 빠지지 않는다. CLOSED까지 포함해 정산 전까지 동기화 시각이 end_at을 넘어
    --          전진하게 한다(7.1). SETTLING 이후는 정산이 키를 지운 시즌이라 대상이 아니다(6.3).
    --        - start_at 60초 전부터 대상에 넣는다. 시작 전 시즌은 비어 있어 재구축이 센티넬만 세우므로, 시작 시각에
    --          순위표가 이미 열려 있다 — 시즌 경계마다 조회가 2007이 되지 않고, 앞 시즌 재구축이 길어도 막히지 않는다.
    --          시작 전 제출은 SP_SUBMIT_SCORE가 시각으로 거부해(1103) 미리 연 순위표에 쓰이지 않는다.
    --        - db_now는 이번 주기의 스캔 시작 시각 T다. 동기화 시각을 앱 시각이 아니라 DB 시각으로 남겨 updated_at과
    --          같은 시계로 비교한다(6.2).
    --        - synced_at은 리컨실러 동기화 시각(job_name 'reconciler'), audit_at은 보조 점검 마지막 시각('recovery_audit').
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
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
    -- ponytail: ranking_season 전체를 훑는다. 시즌 행은 랭킹당 주기 수만큼만 쌓여 작다. 수십만 행이 되면 (status, start_at) 인덱스를 둔다.
    SELECT s.ranking_id, s.season_no, s.start_at, s.end_at, s.status,
           w.synced_at, a.last_run_at AS audit_at, v_now AS db_now
      FROM ranking_season s
      LEFT JOIN job_state w
             ON w.job_name = 'reconciler' AND w.ranking_id = s.ranking_id AND w.season_no = s.season_no
      LEFT JOIN job_state a
             ON a.job_name = 'recovery_audit' AND a.ranking_id = s.ranking_id AND a.season_no = s.season_no
     WHERE s.start_at <= v_now + INTERVAL 60 SECOND AND s.status <= 3
     ORDER BY s.ranking_id, s.season_no;
END$$
DELIMITER ;
