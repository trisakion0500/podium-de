DROP PROCEDURE IF EXISTS `SP_ADVANCE_SEASON_STATUS`;
DELIMITER $$
CREATE PROCEDURE `SP_ADVANCE_SEASON_STATUS` (
) COMMENT '시각이 지난 시즌을 SCHEDULED→OPEN, OPEN(또는 SCHEDULED)→CLOSED로 전이하고 바뀐 수를 반환'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_ADVANCE_SEASON_STATUS
    -- 작성 : 2026.10.10 trisakion
    -- 내용 : 워커 스케줄러가 주기마다 부른다 (01_DESIGN 3.5).
    --        RESULT: 0 성공 [codes.SpResult]. 데이터: closed_count, opened_count
    --
    --        - 상태는 표시와 다음 단계 판단용이다. 제출 차단은 SP_SUBMIT_SCORE의 시각 검사가 하므로 전이가 늦어도
    --          마감은 정확하다(3.5). 그래서 전이는 시각만 보고 일괄로 한다.
    --        - 닫기를 먼저 한다. 워커가 시즌 내내 멈췄다 돌아오면 SCHEDULED에서 바로 CLOSED로 간다 — OPEN을 거치지
    --          않아도 잃는 것이 없다(OPEN 전이에 딸린 작업이 없다. 센티넬은 복구 잡이 시각으로 세운다, D-60).
    --        - 상태전이: 각 UPDATE의 WHERE에 출발 상태(1, 2 / 1)를 둔다. 정산 단계(4 이상)로 간 시즌은 되돌리지 않는다.
    --        - 문장마다 자동 커밋한다. ranking_season 하나만 쓰므로 잠금 순서 3번 하나뿐이다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_closed           INT UNSIGNED    DEFAULT 0;
    DECLARE v_opened           INT UNSIGNED    DEFAULT 0;
    DECLARE sql_state          CHAR(5)         DEFAULT '00000';
    DECLARE error_no           INT             DEFAULT 0;
    DECLARE error_message      VARCHAR(512)    DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    -- ponytail: 상태 조건만으로 전체를 훑는다. 시즌 행이 수십만이 되면 (status, end_at) 인덱스를 둔다.
    UPDATE ranking_season SET status = 3 WHERE status IN (1, 2) AND end_at <= v_now;
    SET v_closed = ROW_COUNT();
    UPDATE ranking_season SET status = 2 WHERE status = 1 AND start_at <= v_now;
    SET v_opened = ROW_COUNT();

    SELECT 0 AS RESULT;
    SELECT v_closed AS closed_count, v_opened AS opened_count;
END$$
DELIMITER ;
