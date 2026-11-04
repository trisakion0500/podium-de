DROP PROCEDURE IF EXISTS `SP_UPDATE_SEASON_REVIEW_END`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_SEASON_REVIEW_END` (
    IN i_requester_id    INT UNSIGNED,    -- 요청자 GM 계정 ID
    IN i_ranking_id      INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no       INT UNSIGNED     -- 시즌 번호 (1 이상)
) COMMENT '조기 확정 (operator). review_until을 지금으로 당겨 정산 잡이 다음 주기에 확정하게 함'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_SEASON_REVIEW_END
    -- 작성 : 2026.11.04 trisakion
    -- 내용 : POST /admin/v1/rankings/{id}/seasons/{n}/review/finalize (01_DESIGN 7.5, 10.4, D-78).
    --        RESULT: 0 성공(이미 끝난 검수 포함), 1001 파라미터, 1002 시즌 없음, 1405 권한 부족, 1701 아직 검수 전, 1702 보류 중 [codes.SpResult]
    --        성공 데이터: status, review_hold, review_until, changed (이번 호출이 값을 바꿨으면 1)
    --        - review_until을 실제 종료 시각으로 맞춰, 이 시각 전에 등록한 제재만 확정에서 제외한다(D-78).
    --        - 전이 자체는 정산 잡이 한다. 확정 절차와 재시도 경로를 하나로 두기 위해서다.
    --        - WHERE의 review_until > 지금: 이미 지났으면 값을 뒤로 밀지 않는다. 재시도해도 기준 시각이 바뀌지 않는다(멱등).
    --        - 보류 중이면 거부한다. review_until만 당겨지고 확정은 진행되지 않는 상태를 만들지 않기 위해서다.
    --        - 단독 자동 커밋 한 문장이다. ranking_season(잠금 순서 3)만 쓴다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_hold             TINYINT UNSIGNED;
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
           OR i_season_no IS NULL OR i_season_no = 0 THEN
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

        UPDATE ranking_season SET review_until = v_now
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no
           AND status = 5 AND review_hold = 0 AND review_until > v_now;
        SET v_changed = ROW_COUNT();

        -- 갱신 0행의 이유(이미 지남, 보류, 상태)를 갱신 뒤의 값으로 가린다.
        SELECT status, review_hold INTO v_status, v_hold
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status < 5 THEN
            SELECT 1701 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status = 5 AND v_hold = 1 THEN
            SELECT 1702 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT status, review_hold, review_until, v_changed AS changed
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
    END proc_block;
END$$
DELIMITER ;
