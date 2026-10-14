DROP PROCEDURE IF EXISTS `SP_UPDATE_REWARD_DELIVERED`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_REWARD_DELIVERED` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,    -- 시즌 번호 (1 이상)
    IN i_member_ids    JSON             -- 우편 발송에 성공한 member_id 문자열 배열 (1~1000개)
) COMMENT '보상 전달 ack: PENDING이고 보류가 아닌 행만 DELIVERED로 (멱등), 반영되지 않은 member_id 반환'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_REWARD_DELIVERED
    -- 작성 : 2026.10.14 trisakion
    -- 내용 : POST /v1/rankings/{id}/seasons/{n}/rewards/ack (01_DESIGN 7.7).
    --        RESULT: 0 성공, 1001 파라미터, 1002 시즌 없음, 1003 아직 DELIVERING 전 [codes.SpResult]
    --        성공 데이터: 반영되지 않은 member_id (보류, REJECTED, 보상 없음, 시즌에 없음). 0행이면 전부 반영
    --
    --        - 조건부 UPDATE(reward_status = 1, reward_held = 0)라 재시도해도 DELIVERED 행은 다시 바뀌지 않고
    --          delivered_at도 처음 ack 시각 그대로다. 이미 DELIVERED인 행은 성공으로 보고 반환 목록에 넣지 않는다.
    --        - DELIVERING 전에는 FINALIZING이 reward_status를 다시 쓰는 중일 수 있어 거부한다. DELIVERING은 되돌아가지
    --          않으므로 상태를 먼저 읽고 갱신해도 된다. SETTLED는 남은 PENDING이 없어 갱신 0행, 재시도 ack는 성공이다.
    --        - member_id 목록은 JSON 배열로 받아 JSON_TABLE로 펼친다 — 동적 SQL 없이 한 문장으로 처리한다(11.2).
    --          member_id가 utf8mb4_bin이라 펼친 값도 같은 콜레이션으로 비교한다(대소문자 구분).
    --        - 잠금 순서: ranking_entry(7) X만 잡는다. ranking_season은 잠그지 않고 읽는다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0
           OR i_member_ids IS NULL OR JSON_TYPE(i_member_ids) <> 'ARRAY'
           OR JSON_LENGTH(i_member_ids) = 0 OR JSON_LENGTH(i_member_ids) > 1000 THEN
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

        START TRANSACTION;
        UPDATE ranking_entry e
          JOIN JSON_TABLE(i_member_ids, '$[*]' COLUMNS (member_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PATH '$')) j
            ON e.member_id = j.member_id
           SET e.reward_status = 2, e.delivered_at = v_now
         WHERE e.ranking_id = i_ranking_id AND e.season_no = i_season_no AND e.reward_status = 1 AND e.reward_held = 0;
        COMMIT;

        SELECT 0 AS RESULT;
        SELECT j.member_id
          FROM JSON_TABLE(i_member_ids, '$[*]' COLUMNS (member_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PATH '$')) j
          LEFT JOIN ranking_entry e
            ON e.ranking_id = i_ranking_id AND e.season_no = i_season_no AND e.member_id = j.member_id
         WHERE e.reward_status IS NULL OR e.reward_status <> 2;
    END proc_block;
END$$
DELIMITER ;
