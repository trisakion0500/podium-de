DROP PROCEDURE IF EXISTS `SP_START_SETTLING`;
DELIMITER $$
CREATE PROCEDURE `SP_START_SETTLING` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,    -- 시즌 번호 (1 이상, CLOSED여야 함)
    IN i_margin_sec    INT UNSIGNED     -- 리컨실러 안전마진(초, RECOVERY_MARGIN_SEC). 동기화 시각이 end_at + 이 값을 넘어야 시작
) COMMENT '정산 시작 조건(settle_at, 미종료 트랜잭션, 리컨실러 동기화 시각)을 확인하고 CLOSED→SETTLING 전이'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_START_SETTLING
    -- 작성 : 2026.10.10 trisakion
    -- 내용 : 01_DESIGN 7.1의 세 조건을 모두 만족할 때만 시즌을 SETTLING으로 바꾼다.
    --        RESULT: 0 성공(이미 SETTLING 포함), 1001 파라미터, 1002 시즌 없음, 1003 상태가 CLOSED/SETTLING 아님,
    --                1009 settle_at 전, 1010 end_at 전에 시작한 트랜잭션이 남음, 1011 리컨실러 동기화 시각 미달 [codes.SpResult]
    --
    --        - 1009~1011은 "아직 아님"이다. 잡은 다음 주기에 다시 부른다. 1010·1011이 오래 이어지면 잡이 경고한다
    --          (긴 트랜잭션, 리컨실러 정지).
    --        - 미종료 트랜잭션: 시각 검사를 end_at 전에 통과한 제출이 아직 커밋되지 않았을 수 있다. INNODB_TRX의
    --          trx_started가 end_at보다 이른 트랜잭션이 하나라도 있으면 기다린다. 조회에 PROCESS 권한이 필요하며,
    --          SP DEFINER(migrate 계정)의 권한으로 읽는다 (03_DEV_SETUP 3.1).
    --          trx_started는 세션 time_zone(+00:00)이 아니라 서버 시스템 시간대로 나온다(KST 서버에서 9시간 늦게 보임, 실측).
    --          그대로 UTC end_at과 비교하면 조건이 늘 거짓이라, CONVERT_TZ(.., 'SYSTEM', '+00:00')로 UTC로 바꿔 비교한다.
    --          'SYSTEM'은 mysql 시간대 테이블 없이 동작한다. 시스템 시간대에 DST가 있으면 되돌아가는 1시간 동안은 변환이
    --          한 시간 어긋날 수 있다. DB 서버 시간대는 UTC나 DST 없는 시간대로 둔다(03_DEV_SETUP).
    --          INNODB_TRX는 InnoDB가 최대 0.1초 캐시한 값이라 방금 끝난 트랜잭션이 보일 수 있다. 다음 주기에 다시 보면 된다.
    --        - 동기화 시각: Redis가 마감 직전 커밋까지 따라잡았음을 보장한다. 정산이 Redis 키를 지운 뒤에는 따라잡을 수 없다.
    --        - 상태전이: WHERE status = 3(CLOSED)인 조건부 UPDATE다. 이 SP 호출과 Redis 키 삭제는 잡이 복구 잡과 같은 락
    --          (podium:recovery) 안에서 한다 — 복구 잡은 SETTLING 이후 시즌을 다시 재구축하지 않는다 (5.6, D-60).
    --        - 단독 자동 커밋 한 문장이다. ranking_season(잠금 순서 3)만 쓰고 job_state는 잠그지 않고 읽는다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_end_at           DATETIME(3);
    DECLARE v_settle_at        DATETIME(3);
    DECLARE v_synced_at        DATETIME(3);
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 OR i_margin_sec IS NULL THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT status, end_at, settle_at INTO v_status, v_end_at, v_settle_at
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status = 4 THEN
            SELECT 0 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 3 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        IF v_now < v_settle_at THEN
            SELECT 1009 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.INNODB_TRX WHERE CONVERT_TZ(trx_started, 'SYSTEM', '+00:00') < v_end_at) THEN
            SELECT 1010 AS RESULT;
            LEAVE proc_block;
        END IF;
        SELECT synced_at INTO v_synced_at
          FROM job_state WHERE job_name = 'reconciler' AND ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_synced_at IS NULL OR v_synced_at <= v_end_at + INTERVAL i_margin_sec SECOND THEN
            SELECT 1011 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE ranking_season SET status = 4
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND status = 3;
        IF ROW_COUNT() = 0 THEN
            -- 확인과 UPDATE 사이에 다른 세션이 바꿨다. 지금 상태로 다시 판단하게 한다.
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
