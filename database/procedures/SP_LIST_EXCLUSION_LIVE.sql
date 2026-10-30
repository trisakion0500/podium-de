DROP PROCEDURE IF EXISTS `SP_LIST_EXCLUSION_LIVE`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_EXCLUSION_LIVE` (
    IN i_ranking_id    INT UNSIGNED     -- 랭킹 ID (1 이상)
) COMMENT '복구 잡 제외 집합 동기화: 전 시즌 제재와 CLOSED 이하 시즌의 제재 멤버'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_EXCLUSION_LIVE
    -- 작성 : 2026.10.30 trisakion
    -- 내용 : 리컨실러가 1분마다 Redis 제외 집합(:excl)을 DB에 맞출 때 읽는다 (01_DESIGN 6.2, 7.8, D-75).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: season_no (0:전 시즌), member_id
    --        - Redis 순위표가 있는 시즌(CLOSED 이하)만 읽는다. SETTLING 이후는 정산이 키를 지운 시즌이다.
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT x.season_no, x.member_id
          FROM ranking_exclusion x
          LEFT JOIN ranking_season s ON s.ranking_id = x.ranking_id AND s.season_no = x.season_no
         WHERE x.ranking_id = i_ranking_id AND (x.season_no = 0 OR s.status <= 3);
    END proc_block;
END$$
DELIMITER ;
