DROP PROCEDURE IF EXISTS `SP_LIST_SEASON_ACTIONABLE`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_SEASON_ACTIONABLE` (
    IN i_offset    INT UNSIGNED,         -- 시작 위치 (0부터)
    IN i_size      SMALLINT UNSIGNED     -- 최대 행 수 (1~100)
) COMMENT '작업 대기 시즌: 전 랭킹의 REVIEW·DELIVERING 시즌 (오래된 순)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_SEASON_ACTIONABLE
    -- 작성 : 2026.11.04 trisakion
    -- 내용 : GET /admin/v1/seasons/actionable (01_DESIGN 10.4, D-82). 역할 확인(viewer)은 앱이 한다 — 상태를 바꾸지 않는 조회라서다.
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: 시즌 행과 total_count. 범위 밖이면 total_count만 채운 1행 — 개발 컨벤션 4.6의 LEFT JOIN ON TRUE
    --        - GM이 검수·전달 조작할 시즌을 찾는 시작점이다. 랭킹 상세는 SCHEDULED·OPEN 시즌만 돌려준다.
    --        - remaining은 DELIVERING 시즌의 남은 PENDING 수다. 페이지에 든 시즌만 ix_reward_status로 센다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    --        ponytail: 상태 조건으로 전체를 훑는다(SP_LIST_SETTLE_TARGET과 같음). 시즌 행이 수십만이 되면 (status, end_at) 인덱스를 둔다.
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
        SELECT p.ranking_id, p.ranking_code, p.ranking_name, p.season_no, p.status, p.end_at, p.review_until, p.review_hold,
               IF(p.status = 7,
                  (SELECT COUNT(e.member_id) FROM ranking_entry e
                    WHERE e.ranking_id = p.ranking_id AND e.season_no = p.season_no AND e.reward_status = 1),
                  NULL) AS remaining,
               cnt.total_count
          FROM (SELECT COUNT(season_no) AS total_count FROM ranking_season WHERE status IN (5, 7)) cnt
          LEFT JOIN (
                SELECT s.ranking_id, d.ranking_code, d.ranking_name, s.season_no, s.status, s.end_at, s.review_until, s.review_hold
                  FROM ranking_season s
                  JOIN ranking_definition d ON d.ranking_id = s.ranking_id
                 WHERE s.status IN (5, 7)
                 ORDER BY s.end_at, s.ranking_id, s.season_no
                 LIMIT i_size OFFSET i_offset
          ) p ON TRUE
         ORDER BY p.end_at, p.ranking_id, p.season_no;
    END proc_block;
END$$
DELIMITER ;
