DROP PROCEDURE IF EXISTS `SP_INSERT_RANKING_SUSPICION`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_RANKING_SUSPICION` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,    -- 시즌 번호 (1 이상)
    IN i_items         JSON             -- 근거 배열 [{memberId, ruleCode, weight, evidence}] (1~1000개)
) COMMENT '소프트 탐지 근거 적재 (리컨실러). 시즌·멤버·규칙마다 한 번만 남는다'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_RANKING_SUSPICION
    -- 작성 : 2026.11.22 trisakion
    -- 내용 : 리컨실러 L2 스캔의 소프트 탐지 결과 적재 (01_DESIGN 9.2, 9.3, D-76, D-83).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: inserted (새로 적재한 행 수)
    --
    --        - INSERT IGNORE라 이미 걸린 규칙은 다시 넣지 않는다(ux_rule). 스캔마다 같은 멤버가 다시 걸려도 포인트가 늘지 않는다.
    --          값은 앱이 만든 것이라 IGNORE가 숨길 잘림이 없다 — member_id·rule_code 길이는 컬럼과 같다.
    --        - 배열은 JSON_TABLE로 펼친다 — 동적 SQL 없이 한 문장으로 처리한다(11.2).
    --        - 단독 자동 커밋 한 문장이다. ranking_suspicion(잠금 순서 5)만 쓴다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_inserted         INT             DEFAULT 0;
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
           OR i_items IS NULL OR JSON_TYPE(i_items) <> 'ARRAY'
           OR JSON_LENGTH(i_items) = 0 OR JSON_LENGTH(i_items) > 1000 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        INSERT IGNORE INTO ranking_suspicion (ranking_id, season_no, member_id, rule_code, weight, evidence, created_at)
        SELECT i_ranking_id, i_season_no, j.member_id, j.rule_code, j.weight, j.evidence, v_now
          FROM JSON_TABLE(i_items, '$[*]' COLUMNS (
                   member_id    VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin    PATH '$.memberId'   ERROR ON EMPTY,
                   rule_code    VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin    PATH '$.ruleCode'   ERROR ON EMPTY,
                   weight       INT UNSIGNED                                             PATH '$.weight'     ERROR ON EMPTY,
                   evidence     JSON                                                     PATH '$.evidence'   ERROR ON EMPTY)) j;
        SET v_inserted = ROW_COUNT();

        SELECT 0 AS RESULT;
        SELECT v_inserted AS inserted;
    END proc_block;
END$$
DELIMITER ;
