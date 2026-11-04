DROP PROCEDURE IF EXISTS `SP_UPDATE_SEASON_REVIEW_HOLD`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_SEASON_REVIEW_HOLD` (
    IN i_requester_id    INT UNSIGNED,        -- 요청자 GM 계정 ID
    IN i_ranking_id      INT UNSIGNED,        -- 랭킹 ID (1 이상)
    IN i_season_no       INT UNSIGNED,        -- 시즌 번호 (1 이상)
    IN i_hold            TINYINT UNSIGNED     -- 1:보류, 0:해제
) COMMENT '검수 보류·해제 (operator). 해제할 때 review_until이 지났으면 지금으로 맞춤'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_SEASON_REVIEW_HOLD
    -- 작성 : 2026.11.04 trisakion
    -- 내용 : POST·DELETE /admin/v1/rankings/{id}/seasons/{n}/review/hold (01_DESIGN 7.5, 10.4, D-78, D-82).
    --        RESULT: 0 성공(이미 그 상태 포함), 1001 파라미터, 1002 시즌 없음, 1405 권한 부족, 1701 검수 중인 시즌이 아님 [codes.SpResult]
    --        성공 데이터: status, review_hold, review_until, changed (이번 호출이 값을 바꿨으면 1)
    --        - 상태전이: WHERE status = 5인 조건부 UPDATE다. SP_START_FINALIZING도 review_hold = 0을 WHERE에 두므로 같은 행에서
    --          줄을 선다. 보류가 먼저면 전이가 1014, 전이가 먼저면 보류가 1701이다. 어느 쪽에서도 보류가 무시되지 않는다.
    --        - 해제의 GREATEST: 지난 review_until을 지금으로 맞춰, 보류 중 등록한 제재도 확정에서 제외된다(D-78).
    --          아직 지나지 않았으면 남은 검수 기간을 그대로 둔다.
    --        - 멱등: 재시도로 이미 그 상태면 값을 바꾸지 않는다. 해제 재시도는 값이 그대로여서 review_until이 다시 밀리지 않는다.
    --          해제 뒤 워커가 FINALIZING으로 넘긴 다음의 재시도도 성공이다.
    --        - 단독 자동 커밋 한 문장이다. ranking_season(잠금 순서 3)만 쓴다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_changed          INT UNSIGNED    DEFAULT 0;
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
        IF i_requester_id IS NULL OR i_requester_id = 0 OR i_ranking_id IS NULL OR i_ranking_id = 0
           OR i_season_no IS NULL OR i_season_no = 0 OR i_hold IS NULL OR i_hold > 1 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 2 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT status INTO v_status FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;

        IF i_hold = 1 THEN
            UPDATE ranking_season SET review_hold = 1
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND status = 5 AND review_hold = 0;
        ELSE
            UPDATE ranking_season SET review_hold = 0, review_until = GREATEST(review_until, v_now)
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND status = 5 AND review_hold = 1;
        END IF;
        SET v_changed = ROW_COUNT();

        -- 처음 읽은 뒤 워커가 넘겼을 수 있어 갱신 뒤의 상태로 판정한다.
        SELECT status INTO v_status FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status < 5 OR (v_status > 5 AND i_hold = 1) THEN
            SELECT 1701 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT status, review_hold, review_until, v_changed AS changed
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
    END proc_block;
END$$
DELIMITER ;
