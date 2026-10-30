DROP PROCEDURE IF EXISTS `SP_GET_RANKING_ENTRY_APPLY`;
DELIMITER $$
CREATE PROCEDURE `SP_GET_RANKING_ENTRY_APPLY` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,    -- 시즌 번호 (1 이상)
    IN i_member_id     VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin  -- 멤버 ID (대소문자 구분)
) COMMENT '제재 해제 뒤 Redis 재반영용: 원장 행 하나와 composite 계산에 필요한 정의·시즌 값'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_GET_RANKING_ENTRY_APPLY
    -- 작성 : 2026.10.30 trisakion
    -- 내용 : 제재를 풀면 원장 값으로 순위표에 다시 반영한다 (01_DESIGN 7.8, D-75). 관리 API와 복구 잡의 동기화가 부른다.
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: score, achieved_at, version, start_at, update_rule, sort_order, time_unit, time_bits
    --                     (제출이 없는 멤버면 0행)
    --        - 관리 API 프로세스는 랭킹 정의 캐시를 두지 않아 composite에 필요한 값을 함께 돌려준다.
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 OR i_member_id IS NULL THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT e.score, e.achieved_at, e.version, s.start_at, d.update_rule, d.sort_order, d.time_unit, d.time_bits
          FROM ranking_entry e
          JOIN ranking_season s ON s.ranking_id = e.ranking_id AND s.season_no = e.season_no
          JOIN ranking_definition d ON d.ranking_id = e.ranking_id
         WHERE e.ranking_id = i_ranking_id AND e.season_no = i_season_no AND e.member_id = i_member_id;
    END proc_block;
END$$
DELIMITER ;
