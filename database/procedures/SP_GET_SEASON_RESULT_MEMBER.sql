DROP PROCEDURE IF EXISTS `SP_GET_SEASON_RESULT_MEMBER`;
DELIMITER $$
CREATE PROCEDURE `SP_GET_SEASON_RESULT_MEMBER` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,    -- 시즌 번호 (1 이상)
    IN i_member_id     VARCHAR(64)      -- 멤버 ID (대소문자 구분)
) COMMENT '확정된 시즌의 멤버 한 명 결과 (DELIVERING 이후)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_GET_SEASON_RESULT_MEMBER
    -- 작성 : 2026.10.14 trisakion
    -- 내용 : GET /v1/rankings/{id}/seasons/{n}/results/{memberId} (01_DESIGN 8.5, 10.2).
    --        RESULT: 0 성공, 1001 파라미터, 1002 시즌 없음, 1003 아직 확정 전 [codes.SpResult]
    --        성공 데이터: final_rank(제재 제외면 NULL), score, reward_code, reward_status, sanctioned. 기록이 없으면 0행
    --
    --        - PK 한 행 조회다. 확정 전(가순위)은 SP_LIST_SEASON_RESULT와 같은 이유로 거부한다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
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
           OR i_member_id IS NULL OR i_member_id = '' THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT status INTO v_status
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
        SELECT final_rank, score, reward_code, reward_status, sanctioned
          FROM ranking_entry
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id;
    END proc_block;
END$$
DELIMITER ;
