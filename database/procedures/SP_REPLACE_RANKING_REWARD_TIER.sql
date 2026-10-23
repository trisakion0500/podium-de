DROP PROCEDURE IF EXISTS `SP_REPLACE_RANKING_REWARD_TIER`;
DELIMITER $$
CREATE PROCEDURE `SP_REPLACE_RANKING_REWARD_TIER` (
    IN i_requester_id    INT UNSIGNED,    -- 요청자 GM 계정 ID
    IN i_ranking_id      INT UNSIGNED,    -- 랭킹 ID
    IN i_tiers           JSON             -- 새 보상 구간 배열 [{tierNo, rangeType, rangeFrom, rangeTo, rewardCode}] (빈 배열:보상 없음)
) COMMENT '랭킹 보상 구간 전체 교체 (operator, 아직 FINALIZING 전인 시즌부터 반영)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_REPLACE_RANKING_REWARD_TIER
    -- 작성 : 2026.10.23 trisakion
    -- 내용 : PUT /admin/v1/rankings/{id}/tiers (01_DESIGN 2.6, 2.8, 10.4).
    --        RESULT: 0 성공, 1001 파라미터, 1405 권한 부족, 1501 랭킹 없음 [codes.SpResult]
    --        성공 데이터: 바뀌기 전 구간 JSON 1행 (감사 로그용)
    --        - 구간 값 검증(from ≤ to, PERCENT ≤ 100, tier_no 중복)은 앱이 한다.
    --        - 확정 시작(FINALIZING)이 구간을 tier_snapshot으로 고정하므로, 이미 확정에 들어간 시즌에는 영향이 없다(7.6).
    --          확정 SP는 잠그지 않는 읽기로 구간을 읽어, 교체 트랜잭션의 커밋 전 또는 후 중 한쪽 전체만 본다.
    --        - 동시 교체를 줄 세우려고 정의 행을 먼저 FOR UPDATE로 잠근다. 제출 SP는 정의를 잠그지 않는 읽기로 읽어 막히지 않는다.
    --        - 잠금 순서: ranking_definition → ranking_reward_tier (TABLE_LOCK_ORDER 1, 2).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_found            INT UNSIGNED;
    DECLARE v_before           JSON;
    DECLARE sql_state          CHAR(5)         DEFAULT '00000';
    DECLARE error_no           INT             DEFAULT 0;
    DECLARE error_message      VARCHAR(512)    DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        ROLLBACK;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    proc_block: BEGIN
        IF i_requester_id IS NULL OR i_requester_id = 0 OR i_ranking_id IS NULL OR i_ranking_id = 0
           OR i_tiers IS NULL OR JSON_TYPE(i_tiers) <> 'ARRAY' THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 2 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        START TRANSACTION;

        SELECT ranking_id INTO v_found FROM ranking_definition WHERE ranking_id = i_ranking_id FOR UPDATE;
        IF v_found IS NULL THEN
            ROLLBACK;
            SELECT 1501 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT JSON_ARRAYAGG(JSON_OBJECT('tierNo', tier_no, 'rangeType', range_type, 'rangeFrom', range_from, 'rangeTo', range_to, 'rewardCode', reward_code))
          INTO v_before
          FROM ranking_reward_tier
         WHERE ranking_id = i_ranking_id;

        DELETE FROM ranking_reward_tier WHERE ranking_id = i_ranking_id;

        INSERT INTO ranking_reward_tier (ranking_id, tier_no, range_type, range_from, range_to, reward_code)
        SELECT i_ranking_id, t.tier_no, t.range_type, t.range_from, t.range_to, t.reward_code
          FROM JSON_TABLE(i_tiers, '$[*]' COLUMNS (
                   tier_no        SMALLINT UNSIGNED    PATH '$.tierNo',
                   range_type     TINYINT UNSIGNED     PATH '$.rangeType',
                   range_from     INT UNSIGNED         PATH '$.rangeFrom',
                   range_to       INT UNSIGNED         PATH '$.rangeTo',
                   reward_code    VARCHAR(64)          PATH '$.rewardCode')) t;

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT IFNULL(v_before, JSON_ARRAY()) AS before_tiers;
    END proc_block;
END$$
DELIMITER ;
