DROP PROCEDURE IF EXISTS `SP_LIST_RANKING_ENTRY_CHUNK`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_RANKING_ENTRY_CHUNK` (
    IN i_ranking_id         INT UNSIGNED,                    -- 랭킹 ID (1 이상)
    IN i_season_no          INT UNSIGNED,                    -- 시즌 번호 (1 이상)
    IN i_after_member_id    VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,  -- PK 커서: 이 member 다음 (첫 청크는 '')
    IN i_limit              INT UNSIGNED                     -- 청크 크기 (1~10000)
) COMMENT '재구축 적재: 시즌 파티션을 member_id(PK) 순 청크로, 제재 제외 대상 제외'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_RANKING_ENTRY_CHUNK
    -- 작성 : 2026.10.09 trisakion
    -- 내용 : L3 재구축 1단계가 임시 키에 적재할 행을 읽는다 (01_DESIGN 6.3).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: member_id, score, achieved_at, version (member_id 순)
    --
    --        - PK (ranking_id, season_no, member_id) 범위 읽기라 청크마다 파티션 하나의 인덱스 구간만 읽는다.
    --        - 청크 사이에 바뀐 행은 재구축 시작 시각부터의 따라잡기(SP_LIST_RANKING_ENTRY_CHANGED)가 다시 읽는다.
    --        - 제재 제외 대상은 거른다(7.8). 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0
           OR i_season_no IS NULL OR i_season_no = 0
           OR i_after_member_id IS NULL
           OR i_limit IS NULL OR i_limit = 0 OR i_limit > 10000 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT e.member_id, e.score, e.achieved_at, e.version
          FROM ranking_entry e
         WHERE e.ranking_id = i_ranking_id AND e.season_no = i_season_no
           AND e.member_id > i_after_member_id
           AND NOT EXISTS (
                SELECT 1 FROM ranking_exclusion x
                 WHERE x.ranking_id = e.ranking_id AND x.season_no IN (e.season_no, 0) AND x.member_id = e.member_id)
         ORDER BY e.member_id
         LIMIT i_limit;
    END proc_block;
END$$
DELIMITER ;
