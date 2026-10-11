DROP PROCEDURE IF EXISTS `SP_UPDATE_SEASON_DELIVERING`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_SEASON_DELIVERING` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED     -- 시즌 번호 (1 이상, FINALIZING이고 순위 재부여가 끝났어야 함)
) COMMENT '확정 순위 상위 top_size를 ranking_season_top에 적재하고 FINALIZING → DELIVERING 전이 (한 트랜잭션)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_SEASON_DELIVERING
    -- 작성 : 2026.10.11 trisakion
    -- 내용 : FINALIZING 6·7단계 (01_DESIGN 7.6, 8.4). 잡이 순위 재부여를 한 바퀴 끝낸 뒤 부른다.
    --        RESULT: 0 성공(이미 DELIVERING 이후 포함), 1001 파라미터, 1002 시즌 없음, 1003 상태가 FINALIZING 아님,
    --                1015 확정 미완료(participant_count 없음, 또는 MAX(final_rank) ≠ participant_count) [codes.SpResult]
    --
    --        - 재부여가 끝나면 순위는 1..participant_count로 빈칸 없이 이어진다. MAX(final_rank)가 참가자 수와 다르면
    --          제재로 빠진 자리가 아직 당겨지지 않은 것이라 전이하지 않는다. 제재 행이 가순위 꼴찌뿐이면 재부여 전에도
    --          같을 수 있어 완전한 확인은 아니다 — 잡이 같은 실행 안에서 재부여를 끝까지 돈 뒤에만 부르는 것이 전제다.
    --        - 상태 전이와 Top N 적재를 한 트랜잭션으로 묶는다. DELIVERING이면 Top N이 반드시 있고, 이미 DELIVERING
    --          이후면 적재도 끝난 것이라 다시 넣지 않는다(재시도 멱등). 조건부 UPDATE(status = 6)의 ROW_COUNT가 0이면
    --          다른 실행이 먼저 넘긴 것이라 그대로 성공을 돌려준다.
    --        - 잠금 순서: ranking_season(3) X → ranking_entry(7) INSERT ... SELECT의 S → ranking_season_top(9) X.
    --          제재 행은 final_rank가 NULL이라 Top N에 들어가지 않는다. sanctioned는 지급 후 제재(6단계 운영 도구)에서 갱신한다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_count            INT UNSIGNED;
    DECLARE v_top_size         SMALLINT UNSIGNED;
    DECLARE v_max              INT UNSIGNED;
    DECLARE sql_state          CHAR(5)         DEFAULT '00000';
    DECLARE error_no           INT             DEFAULT 0;
    DECLARE error_message      VARCHAR(512)    DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        ROLLBACK;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    proc_block: BEGIN
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT s.status, s.participant_count, d.top_size INTO v_status, v_count, v_top_size
          FROM ranking_season s
          JOIN ranking_definition d ON d.ranking_id = s.ranking_id
         WHERE s.ranking_id = i_ranking_id AND s.season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status > 6 THEN
            SELECT 0 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 6 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT MAX(final_rank) INTO v_max
          FROM ranking_entry WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_count IS NULL OR COALESCE(v_max, 0) <> v_count THEN
            SELECT 1015 AS RESULT;
            LEAVE proc_block;
        END IF;

        START TRANSACTION;
        UPDATE ranking_season SET status = 7
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND status = 6;
        IF ROW_COUNT() = 0 THEN
            ROLLBACK;
            SELECT 0 AS RESULT;
            LEAVE proc_block;
        END IF;

        INSERT INTO ranking_season_top (ranking_id, season_no, final_rank, member_id, score, sanctioned)
        SELECT ranking_id, season_no, final_rank, member_id, score, 0
          FROM ranking_entry
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank BETWEEN 1 AND v_top_size;
        COMMIT;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
