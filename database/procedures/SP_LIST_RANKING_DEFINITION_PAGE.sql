DROP PROCEDURE IF EXISTS `SP_LIST_RANKING_DEFINITION_PAGE`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_RANKING_DEFINITION_PAGE` (
    IN i_offset    INT UNSIGNED,         -- 시작 위치 (0부터)
    IN i_size      SMALLINT UNSIGNED     -- 최대 행 수 (1~100)
) COMMENT '관리 API용 랭킹 목록 페이징 (ID순)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_RANKING_DEFINITION_PAGE
    -- 작성 : 2026.10.23 trisakion
    -- 내용 : GET /admin/v1/rankings (01_DESIGN 10.4). 역할 확인(VIEWER)은 앱이 한다 — 상태를 바꾸지 않는 조회라서다.
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: 랭킹 요약 행과 total_count. 범위 밖이면 total_count만 채운 1행 — 개발 컨벤션 4.6의 LEFT JOIN ON TRUE
    --        - API 캐시용 SP_LIST_RANKING_DEFINITION과 따로 둔다. 그쪽은 전체를 순위 규칙만 읽는다.
    --        - 랭킹 수는 적어 OFFSET으로 충분하다.
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
        IF i_offset IS NULL OR i_size IS NULL OR i_size = 0 OR i_size > 100 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT p.ranking_id, p.ranking_code, p.ranking_name, p.status, p.update_rule, p.sort_order, p.cycle_type,
               p.start_at, p.end_at, p.updated_at, cnt.total_count
          FROM (SELECT COUNT(ranking_id) AS total_count FROM ranking_definition) cnt
          LEFT JOIN (
                SELECT ranking_id, ranking_code, ranking_name, status, update_rule, sort_order, cycle_type, start_at, end_at, updated_at
                  FROM ranking_definition
                 ORDER BY ranking_id
                 LIMIT i_size OFFSET i_offset
          ) p ON TRUE
         ORDER BY p.ranking_id;
    END proc_block;
END$$
DELIMITER ;
