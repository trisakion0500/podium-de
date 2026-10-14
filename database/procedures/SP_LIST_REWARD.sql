DROP PROCEDURE IF EXISTS `SP_LIST_REWARD`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_REWARD` (
    IN i_ranking_id    INT UNSIGNED,         -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,         -- 시즌 번호 (1 이상)
    IN i_cursor        VARCHAR(64),          -- 이 member_id 다음부터 ('':처음부터)
    IN i_size          SMALLINT UNSIGNED     -- 최대 행 수 (1~1000)
) COMMENT '보상 전달 대상 목록: PENDING이고 보류가 아닌 행을 member_id 오름차순 커서로 (게임 서버 pull)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_REWARD
    -- 작성 : 2026.10.14 trisakion
    -- 내용 : GET /v1/rankings/{id}/seasons/{n}/rewards (01_DESIGN 7.7).
    --        RESULT: 0 성공, 1001 파라미터, 1002 시즌 없음, 1003 아직 DELIVERING 전 [codes.SpResult]
    --        성공 데이터: member_id, final_rank, score, reward_code (0행이면 남은 대상 없음)
    --
    --        - DELIVERING 전에는 FINALIZING이 reward_status를 다시 쓰는 중일 수 있어 거부한다. SETTLED는 남은 PENDING이
    --          없으므로 빈 목록이 나간다(보류 행은 6단계 전환 전까지 대상이 아니다).
    --        - ix_reward_status (ranking_id, season_no, reward_status, member_id)를 member_id 커서로 범위 스캔한다.
    --          reward_held만 행에서 읽는다. ack된 행은 PENDING에서 빠지므로 게임 서버는 커서 없이 처음부터 다시 읽어도 된다.
    --        - member_id는 utf8mb4_bin이라 커서 비교도 바이트 순서다.
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
           OR i_cursor IS NULL OR i_size IS NULL OR i_size = 0 OR i_size > 1000 THEN
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
        SELECT member_id, final_rank, score, reward_code
          FROM ranking_entry
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND reward_status = 1
           AND member_id > i_cursor AND reward_held = 0
         ORDER BY member_id
         LIMIT i_size;
    END proc_block;
END$$
DELIMITER ;
