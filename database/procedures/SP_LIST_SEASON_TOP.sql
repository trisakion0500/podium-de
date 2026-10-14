DROP PROCEDURE IF EXISTS `SP_LIST_SEASON_TOP`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_SEASON_TOP` (
    IN i_ranking_id    INT UNSIGNED,         -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,         -- 시즌 번호 (1 이상)
    IN i_offset        INT UNSIGNED,         -- 시작 위치 (0부터, 순위 i_offset + 1부터)
    IN i_size          SMALLINT UNSIGNED     -- 최대 행 수 (1~100)
) COMMENT '시즌별 Top N 페이징 (ranking_season_top, 영구 보관)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_SEASON_TOP
    -- 작성 : 2026.10.14 trisakion
    -- 내용 : GET /v1/rankings/{id}/seasons/{n}/top (01_DESIGN 8.4, 8.5, 10.2).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: final_rank, member_id, score, sanctioned (확정 전이거나 범위 밖이면 0행)
    --
    --        - 시즌 상태를 보지 않는다. Top N은 DELIVERING 전이와 한 트랜잭션에서 적재되므로(SP_UPDATE_SEASON_DELIVERING)
    --          행이 있으면 확정된 것이다. 시즌 행이 정리된 뒤에도 영구 조회되도록 ranking_season에 기대지 않는다.
    --        - PK (ranking_id, season_no, final_rank) 범위로 페이지만 읽는다.
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0
           OR i_offset IS NULL OR i_size IS NULL OR i_size = 0 OR i_size > 100 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT final_rank, member_id, score, sanctioned
          FROM ranking_season_top
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no
           AND final_rank BETWEEN i_offset + 1 AND i_offset + i_size
         ORDER BY final_rank;
    END proc_block;
END$$
DELIMITER ;
