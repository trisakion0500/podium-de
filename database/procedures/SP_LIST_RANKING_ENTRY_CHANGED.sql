DROP PROCEDURE IF EXISTS `SP_LIST_RANKING_ENTRY_CHANGED`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_RANKING_ENTRY_CHANGED` (
    IN i_ranking_id         INT UNSIGNED,                    -- 랭킹 ID (1 이상)
    IN i_season_no          INT UNSIGNED,                    -- 시즌 번호 (1 이상)
    IN i_after_updated_at   DATETIME(3),                     -- 키셋 커서: 이 updated_at 이후 (첫 청크는 동기화 시각 − 안전마진)
    IN i_after_member_id    VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,  -- 키셋 커서: 같은 updated_at에서 이 member 다음 (첫 청크는 '')
    IN i_limit              INT UNSIGNED                     -- 청크 크기 (1~10000)
) COMMENT '리컨실러 변경분 스캔: (updated_at, member_id) 키셋 청크, 제재 제외 대상 제외'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_RANKING_ENTRY_CHANGED
    -- 작성 : 2026.10.09 trisakion
    -- 내용 : L2 리컨실러와 재구축 따라잡기가 쓴다 (01_DESIGN 6.2, 6.3).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: member_id, score, achieved_at, version, updated_at (updated_at, member_id 순)
    --
    --        - 커서를 (updated_at, member_id) 둘로 둔다. updated_at만 쓰면 같은 시각에 바뀐 행이 청크 경계에 걸릴 때
    --          빠지거나 반복된다. ix_updated_at (ranking_id, season_no, updated_at)에 PK의 member_id가 붙어 있어
    --          정렬과 범위가 인덱스로 끝난다. 행 생성자 비교 대신 OR로 풀어 써야 범위 최적화가 확실히 걸린다.
    --        - 첫 청크는 커서 member를 ''로 준다. updated_at = 커서인 행도 포함되는데, 안전마진 안이라 상관없다.
    --        - 제재 제외(ranking_exclusion, season_no 0은 전 시즌)는 여기서 거른다. 리컨실러가 제외 대상을 Redis에
    --          다시 넣지 않게 한다(7.8). 걸러진 행은 LIMIT 전에 빠지므로 커서는 반환된 마지막 행으로 넘기면 된다.
    --        - 반드시 마스터에서 부른다(6.2). 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
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
           OR i_after_updated_at IS NULL OR i_after_member_id IS NULL
           OR i_limit IS NULL OR i_limit = 0 OR i_limit > 10000 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT e.member_id, e.score, e.achieved_at, e.version, e.updated_at
          FROM ranking_entry e
         WHERE e.ranking_id = i_ranking_id AND e.season_no = i_season_no
           AND (e.updated_at > i_after_updated_at
                OR (e.updated_at = i_after_updated_at AND e.member_id > i_after_member_id))
           AND NOT EXISTS (
                SELECT 1 FROM ranking_exclusion x
                 WHERE x.ranking_id = e.ranking_id AND x.season_no IN (e.season_no, 0) AND x.member_id = e.member_id)
         ORDER BY e.updated_at, e.member_id
         LIMIT i_limit;
    END proc_block;
END$$
DELIMITER ;
