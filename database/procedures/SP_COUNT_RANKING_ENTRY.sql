DROP PROCEDURE IF EXISTS `SP_COUNT_RANKING_ENTRY`;
DELIMITER $$
CREATE PROCEDURE `SP_COUNT_RANKING_ENTRY` (
    IN i_ranking_id    INT UNSIGNED,  -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED   -- 시즌 번호 (1 이상)
) COMMENT '보조 점검: 시즌 entry 수 (제재 제외 대상 제외) — Redis ZCARD와 비교'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_COUNT_RANKING_ENTRY
    -- 작성 : 2026.10.09 trisakion
    -- 내용 : 복구 잡이 시즌마다 1시간 1회 Redis ZCARD와 비교한다 (01_DESIGN 6.4).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: entry_count
    --
    --        - 리컨실러·재구축과 같은 기준이어야 하므로 제재 제외 대상을 똑같이 뺀다.
    --        - 시즌 파티션 하나를 끝까지 읽는다(100만 행 약 0.45초). 1시간 1회라 감수한다.
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

    proc_block: BEGIN
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT COUNT(*) AS entry_count
          FROM ranking_entry e
         WHERE e.ranking_id = i_ranking_id AND e.season_no = i_season_no
           AND NOT EXISTS (
                SELECT 1 FROM ranking_exclusion x
                 WHERE x.ranking_id = e.ranking_id AND x.season_no IN (e.season_no, 0) AND x.member_id = e.member_id);
    END proc_block;
END$$
DELIMITER ;
