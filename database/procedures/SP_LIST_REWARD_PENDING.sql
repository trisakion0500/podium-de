DROP PROCEDURE IF EXISTS `SP_LIST_REWARD_PENDING`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_REWARD_PENDING` (
) COMMENT '전달 대기 시즌: DELIVERING 시즌과 남은 전달 대상 수 (end_at 순)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_REWARD_PENDING
    -- 작성 : 2026.10.14 trisakion
    -- 내용 : GET /v1/rewards/pending과 워커 전달 잡(SETTLED 전이, ack 정체·적체 경고)이 함께 쓴다 (01_DESIGN 7.7).
    --        RESULT: 0 성공 [codes.SpResult]
    --        성공 데이터: ranking_id, season_no, end_at, remaining (PENDING이고 보류가 아닌 행 수, 0이면 곧 SETTLED)
    --
    --        - 장애에서 복구한 게임 서버가 오래된 시즌부터 가져가도록 end_at 순으로 돌려준다.
    --        - 남은 수는 ix_reward_status로 시즌의 PENDING 범위만 센다. reward_held만 행에서 읽는다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
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
    -- ponytail: 상태 조건으로 ranking_season 전체를 훑는다(SP_LIST_SETTLE_TARGET과 같음). 시즌 행이 수십만이 되면 status 인덱스를 둔다.
    SELECT s.ranking_id, s.season_no, s.end_at,
           (SELECT COUNT(e.member_id) FROM ranking_entry e
             WHERE e.ranking_id = s.ranking_id AND e.season_no = s.season_no AND e.reward_status = 1 AND e.reward_held = 0) AS remaining
      FROM ranking_season s
     WHERE s.status = 7
     ORDER BY s.end_at, s.ranking_id, s.season_no;
END$$
DELIMITER ;
