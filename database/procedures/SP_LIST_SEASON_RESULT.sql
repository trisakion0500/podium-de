DROP PROCEDURE IF EXISTS `SP_LIST_SEASON_RESULT`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_SEASON_RESULT` (
    IN i_ranking_id    INT UNSIGNED,         -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,         -- 시즌 번호 (1 이상)
    IN i_offset        INT UNSIGNED,         -- 시작 위치 (0부터, 확정 순위 i_offset + 1부터)
    IN i_size          SMALLINT UNSIGNED     -- 최대 행 수 (1~100)
) COMMENT '확정된 시즌 결과 페이징 (ranking_entry.final_rank, DELIVERING 이후)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_SEASON_RESULT
    -- 작성 : 2026.10.14 trisakion
    -- 내용 : GET /v1/rankings/{id}/seasons/{n}/results (01_DESIGN 8.5, 10.2).
    --        RESULT: 0 성공, 1001 파라미터, 1002 시즌 없음, 1003 아직 확정 전 [codes.SpResult]
    --        성공 데이터: participant_count와 final_rank, member_id, score, reward_code, sanctioned.
    --                     범위 밖이면 participant_count만 채운 1행(나머지 NULL) — 개발 컨벤션 4.6의 LEFT JOIN ON TRUE
    --
    --        - DELIVERING 전의 final_rank는 가순위라 보여 주지 않는다. 확정 순위는 1..participant_count로 빈칸이 없어
    --          OFFSET 대신 ix_final_rank 범위(BETWEEN)로 페이지만 읽는다.
    --        - 제재로 제외된 행은 final_rank가 NULL이라 나오지 않는다. 지급 후 제재는 순위를 유지하고 sanctioned = 1이다(7.8).
    --        - 백업으로 분리된 시즌(5단계)은 운영 테이블에 행이 없어 빈 목록이다. 지난 시즌 상위는 ranking_season_top으로 본다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_count            INT UNSIGNED;
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

        SELECT status, participant_count INTO v_status, v_count
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status < 7 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT p.final_rank, p.member_id, p.score, p.reward_code, p.sanctioned, cnt.participant_count
          FROM (SELECT v_count AS participant_count) cnt
          LEFT JOIN (
                SELECT final_rank, member_id, score, reward_code, sanctioned
                  FROM ranking_entry
                 WHERE ranking_id = i_ranking_id AND season_no = i_season_no
                   AND final_rank BETWEEN i_offset + 1 AND i_offset + i_size
          ) p ON TRUE
         ORDER BY p.final_rank;
    END proc_block;
END$$
DELIMITER ;
