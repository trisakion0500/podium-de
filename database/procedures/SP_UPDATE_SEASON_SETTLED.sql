DROP PROCEDURE IF EXISTS `SP_UPDATE_SEASON_SETTLED`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_SEASON_SETTLED` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED     -- 시즌 번호 (1 이상, DELIVERING이고 남은 전달 대상이 없어야 함)
) COMMENT '남은 전달 대상(PENDING, 보류 제외)이 없는 DELIVERING 시즌을 SETTLED로 전이'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_SEASON_SETTLED
    -- 작성 : 2026.10.14 trisakion
    -- 내용 : 워커 전달 잡이 남은 수 0인 시즌에 부른다 (01_DESIGN 7.7). 보상 대상이 없는 시즌(빈 시즌, 구간 없음)도 이 길로 끝난다.
    --        RESULT: 0 성공(이미 SETTLED 포함), 1001 파라미터, 1002 시즌 없음, 1003 DELIVERING 아님,
    --                1016 남은 전달 대상 있음 [codes.SpResult]
    --
    --        - 남은 대상 확인과 전이를 한 문장(조건부 UPDATE + NOT EXISTS)으로 한다. 목록을 읽은 뒤 무엇이 바뀌어도
    --          PENDING이 남아 있으면 갱신 0행이다. 보류 행(reward_held = 1)은 남은 대상으로 보지 않는다 — 6단계 GM 전환 전까지
    --          PENDING으로 남은 채 백업으로 분리된다(7.7).
    --        - 잠금 순서: ranking_season(3) X → ranking_entry(7) NOT EXISTS 서브쿼리의 S.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
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

        SELECT status INTO v_status
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status = 8 THEN
            SELECT 0 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 7 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        START TRANSACTION;
        UPDATE ranking_season SET status = 8, settled_at = UTC_TIMESTAMP(3)
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND status = 7
           AND NOT EXISTS (SELECT 1 FROM ranking_entry e
                            WHERE e.ranking_id = i_ranking_id AND e.season_no = i_season_no
                              AND e.reward_status = 1 AND e.reward_held = 0);
        IF ROW_COUNT() = 0 THEN
            ROLLBACK;
            SELECT 1016 AS RESULT;
            LEAVE proc_block;
        END IF;
        COMMIT;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
