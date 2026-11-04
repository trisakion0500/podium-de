DROP PROCEDURE IF EXISTS `SP_UPDATE_SEASON_FORCE_SETTLED`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_SEASON_FORCE_SETTLED` (
    IN i_requester_id    INT UNSIGNED,    -- 요청자 GM 계정 ID
    IN i_ranking_id      INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no       INT UNSIGNED,    -- 시즌 번호 (1 이상)
    IN i_reason          VARCHAR(255)     -- 강제 종료 사유 (1~255자)
) COMMENT 'DELIVERING 강제 종료 (operator). 남은 PENDING은 그대로 두고 SETTLED로 넘김'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_SEASON_FORCE_SETTLED
    -- 작성 : 2026.11.04 trisakion
    -- 내용 : POST /admin/v1/rankings/{id}/seasons/{n}/force-settle (01_DESIGN 7.7, 10.4, D-47, D-82).
    --        RESULT: 0 성공(이미 강제 종료됨 포함), 1001 파라미터, 1002 시즌 없음, 1405 권한 부족, 1703 전달 중인 시즌이 아님 [codes.SpResult]
    --        성공 데이터: forced_by, forced_reason, settled_at, remaining (남은 PENDING 수, 재시도면 NULL), changed (이번 호출이 넘겼으면 1)
    --        - 상태전이: WHERE status = 7인 조건부 UPDATE다. 워커의 정상 SETTLED 전이와 겹쳐도 한쪽만 갱신한다.
    --        - 재시도(forced_by 있음)는 처음 기록을 그대로 돌려준다. 정상 종료된 시즌은 포기할 것이 없어 1703이다.
    --        - remaining은 감사 로그용이다. 잠그지 않고 읽어, 겹친 ack만큼 실제보다 많을 수 있다. 정확한 미전달 건은 reward_status로 본다.
    --        - PENDING 행은 바꾸지 않는다. 백업 분리 잡이 그대로 옮긴다(7.7).
    --        - 단독 자동 커밋 한 문장이다. ranking_season(잠금 순서 3)만 쓰고 ranking_entry는 잠그지 않고 읽는다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_forced_by        INT UNSIGNED;
    DECLARE v_remaining        INT UNSIGNED;
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
           OR i_season_no IS NULL OR i_season_no = 0 OR i_reason IS NULL OR CHAR_LENGTH(i_reason) NOT BETWEEN 1 AND 255 THEN
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

        IF v_status = 7 THEN
            SELECT COUNT(member_id) INTO v_remaining
              FROM ranking_entry
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND reward_status = 1;

            UPDATE ranking_season
               SET status = 8, settled_at = v_now, forced_by = i_requester_id, forced_reason = i_reason
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND status = 7;
            SET v_changed = ROW_COUNT();
        END IF;

        -- 갱신 0행이면 워커나 다른 GM이 먼저 넘겼다. 갱신 뒤의 값으로 판정한다.
        SELECT status, forced_by INTO v_status, v_forced_by
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status <> 8 OR v_forced_by IS NULL THEN
            SELECT 1703 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT forced_by, forced_reason, settled_at, IF(v_changed = 1, v_remaining, NULL) AS remaining, v_changed AS changed
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
    END proc_block;
END$$
DELIMITER ;
