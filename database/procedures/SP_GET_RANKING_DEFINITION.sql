DROP PROCEDURE IF EXISTS `SP_GET_RANKING_DEFINITION`;
DELIMITER $$
CREATE PROCEDURE `SP_GET_RANKING_DEFINITION` (
    IN i_ranking_id    INT UNSIGNED    -- 랭킹 ID
) COMMENT '관리 API용 랭킹 정의 1건 (보상 구간, 끝나지 않은 시즌 포함)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_GET_RANKING_DEFINITION
    -- 작성 : 2026.10.23 trisakion
    -- 내용 : GET /admin/v1/rankings/{id}, 그리고 PATCH가 수정 전 값을 읽을 때 (01_DESIGN 2.8, 10.4).
    --        RESULT: 0 성공, 1001 파라미터, 1501 랭킹 없음 [codes.SpResult]
    --        성공 데이터: 정의 1행. tiers(보상 구간)와 seasons(SCHEDULED·OPEN 시즌)는 JSON 배열 컬럼이다 —
    --        결과셋을 하나로 두는 규약(개발 컨벤션 4.4) 안에서 한 번에 돌려준다.
    --        - 시즌 시각은 ISO 8601(UTC) 문자열이다. JSON 안에서는 DATETIME 타입이 문자열이 되므로 형식을 고정한다.
    --        - PATCH는 스케줄러 락을 잡은 뒤 이 SP로 읽어, 계산하는 동안 시즌이 바뀌지 않는다(2.8).
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_found            INT UNSIGNED;
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        SELECT ranking_id INTO v_found FROM ranking_definition WHERE ranking_id = i_ranking_id;
        IF v_found IS NULL THEN
            SELECT 1501 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT d.ranking_id, d.ranking_code, d.ranking_name, d.status, d.update_rule, d.sort_order, d.score_max, d.time_unit, d.time_bits,
               d.timezone, d.start_at, d.end_at, d.cycle_type, d.cycle_value, d.settle_delay, d.wait_period, d.review_period,
               d.top_size, d.history_retention, d.max_delta, d.max_submit_per_min, d.suspicion_config, d.created_at, d.updated_at,
               (SELECT IFNULL(JSON_ARRAYAGG(JSON_OBJECT('tierNo', t.tier_no, 'rangeType', t.range_type, 'rangeFrom', t.range_from,
                                                        'rangeTo', t.range_to, 'rewardCode', t.reward_code)), JSON_ARRAY())
                  FROM ranking_reward_tier t
                 WHERE t.ranking_id = d.ranking_id) AS tiers,
               (SELECT IFNULL(JSON_ARRAYAGG(JSON_OBJECT('seasonNo', s.season_no, 'status', s.status,
                                                        'startAt', DATE_FORMAT(s.start_at, '%Y-%m-%dT%H:%i:%s.%fZ'),
                                                        'endAt', DATE_FORMAT(s.end_at, '%Y-%m-%dT%H:%i:%s.%fZ'))), JSON_ARRAY())
                  FROM ranking_season s
                 WHERE s.ranking_id = d.ranking_id AND s.status <= 2) AS seasons
          FROM ranking_definition d
         WHERE d.ranking_id = i_ranking_id;
    END proc_block;
END$$
DELIMITER ;
