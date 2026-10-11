DROP PROCEDURE IF EXISTS `SP_UPDATE_FINAL_EXCLUSION`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_FINAL_EXCLUSION` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED     -- 시즌 번호 (1 이상, FINALIZING이어야 함)
) COMMENT 'FINALIZING 시즌에서 제재 대상을 순위에서 빼고(REJECTED) 남은 참가자 수를 participant_count에 기록'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_FINAL_EXCLUSION
    -- 작성 : 2026.10.11 trisakion
    -- 내용 : FINALIZING 1·3단계 (01_DESIGN 7.6). 잡이 순위 재부여(SP_UPDATE_FINAL_RANK) 전에 매번 부른다.
    --        RESULT: 0 성공, 1001 파라미터, 1002 시즌 없음, 1003 상태가 FINALIZING 아님 [codes.SpResult]
    --        성공 데이터: participant_count (제재 제외 참가자 수), tier_snapshot (잡이 보상 공백을 점검한다)
    --
    --        - ranking_exclusion의 이 시즌(season_no)과 전 시즌(0) 대상을 final_rank NULL, sanctioned 1, reward_status
    --          3(REJECTED)로 바꾼다. 가순위로 보상 구간 안이었는지는 따지지 않는다 — 구간 판정은 제재 제외 참가자
    --          수(PERCENT)가 정해진 뒤라야 하고, 제재된 행은 보상 대상이 아니라는 표시로 충분하다.
    --        - 멱등: sanctioned = 0인 행만 바꾸고, 참가자 수는 매번 다시 센다. 재시작해도 결과가 같다.
    --        - 참가자 수 = final_rank가 있는 행 수다. 가순위가 모든 행에 매겨져 있고(SP_UPDATE_SEASON_REVIEW가 보장)
    --          제재 행만 NULL이 된다. ix_final_rank 범위로 센다.
    --        - 두 문장을 각각 자동 커밋한다. 한 트랜잭션으로 묶으면 entry(잠금 순서 7)를 잡은 채 시즌(3)을 갱신해
    --          순서가 거꾸로 된다. 첫 문장은 exclusion(4) S 락, entry(7) X 락 순이다. 둘 사이에 끊겨도 다시 부르면 된다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_count            INT UNSIGNED;
    DECLARE v_tiers            JSON;
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT status, tier_snapshot INTO v_status, v_tiers FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 6 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE ranking_entry e
          JOIN ranking_exclusion x
            ON x.ranking_id = e.ranking_id AND x.season_no IN (0, e.season_no) AND x.member_id = e.member_id
           SET e.final_rank = NULL, e.sanctioned = 1, e.reward_code = NULL, e.reward_status = 3
         WHERE e.ranking_id = i_ranking_id AND e.season_no = i_season_no AND e.sanctioned = 0;

        SELECT COUNT(member_id) INTO v_count
          FROM ranking_entry
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank IS NOT NULL;

        UPDATE ranking_season SET participant_count = v_count
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND status = 6;

        SELECT 0 AS RESULT;
        SELECT v_count AS participant_count, v_tiers AS tier_snapshot;
    END proc_block;
END$$
DELIMITER ;
