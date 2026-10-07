DROP PROCEDURE IF EXISTS `SP_LIST_RANKING_DEFINITION`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_RANKING_DEFINITION` (
) COMMENT 'API 메모리 캐시용 랭킹 정의 목록 (순위 규칙, 제출 빈도 한도)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_RANKING_DEFINITION
    -- 작성 : 2026.10.07 trisakion
    -- 내용 : API가 기동 시와 30초마다 랭킹 정의를 읽어 메모리에 둔다 (01_DESIGN 4.1, 5.2).
    --        - 제출 빈도 검사(max_submit_per_min)는 SP_SUBMIT_SCORE보다 먼저 해야 하고, composite 계산과 순위 조회는
    --          순위 규칙(update_rule, sort_order, time_unit, time_bits)이 필요하다. 요청마다 읽지 않으려고 전체를 한 번에 읽는다.
    --        - 상태(status)는 참고용이다. 제출 허용 여부는 SP_SUBMIT_SCORE가 원장 기준으로 다시 판정한다.
    --        - 순위 규칙은 등록 후 불변이라 캐시가 늦어도 틀리지 않는다. 늦게 반영되는 것은 max_submit_per_min뿐이다.
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
    SELECT ranking_id, status, update_rule, sort_order, time_unit, time_bits, max_submit_per_min
      FROM ranking_definition
     ORDER BY ranking_id;
END$$
DELIMITER ;
