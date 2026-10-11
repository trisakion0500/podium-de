DROP PROCEDURE IF EXISTS `SP_START_FINALIZING`;
DELIMITER $$
CREATE PROCEDURE `SP_START_FINALIZING` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED     -- 시즌 번호 (1 이상, REVIEW여야 함)
) COMMENT '검수 기간이 지나고 보류가 없는 REVIEW 시즌을 FINALIZING으로 전이하고 보상 구간을 tier_snapshot에 고정'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_START_FINALIZING
    -- 작성 : 2026.10.11 trisakion
    -- 내용 : REVIEW → FINALIZING (01_DESIGN 7.5, 7.6). 워커 정산 잡이 SP_LIST_SETTLE_TARGET의 REVIEW 행마다 부른다.
    --        RESULT: 0 성공(이미 FINALIZING 이후 포함), 1001 파라미터, 1002 시즌 없음, 1003 상태가 REVIEW 아님,
    --                1014 review_until 전이거나 검수 보류(review_hold = 1) [codes.SpResult]
    --
    --        - 보상 구간은 전이와 같은 문장에서 tier_snapshot으로 고정한다(2.6). 이후 ranking_reward_tier를 고쳐도
    --          이 시즌의 판정은 바뀌지 않는다. 구간이 없으면 빈 배열 — 전원 보상 없음(NONE)이다.
    --          스냅샷은 SELECT ... INTO 일관된 읽기로 먼저 만든다. UPDATE의 서브쿼리로 두면 시즌 행(잠금 순서 3)을
    --          잡은 채 구간 행(2)에 S 락을 걸어 순서가 거꾸로 된다.
    --        - 상태전이: WHERE status = 5 AND review_hold = 0 AND review_until <= NOW인 조건부 UPDATE. 확인과 UPDATE
    --          사이에 GM이 보류를 걸었으면 갱신되지 않고 1014다. 이미 FINALIZING 이후면 성공으로 본다(재시도 멱등).
    --        - 단독 자동 커밋 한 문장이다. ranking_season(잠금 순서 3)만 쓴다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_tiers            JSON;
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT status INTO v_status FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status > 5 THEN
            SELECT 0 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 5 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('tier_no', tier_no, 'range_type', range_type, 'range_from', range_from,
                                                  'range_to', range_to, 'reward_code', reward_code)), JSON_ARRAY())
          INTO v_tiers
          FROM ranking_reward_tier WHERE ranking_id = i_ranking_id;

        UPDATE ranking_season SET status = 6, tier_snapshot = v_tiers
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no
           AND status = 5 AND review_hold = 0 AND review_until <= v_now;
        IF ROW_COUNT() = 0 THEN
            SELECT 1014 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
