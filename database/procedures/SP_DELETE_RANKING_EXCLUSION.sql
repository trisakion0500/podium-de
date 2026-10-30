DROP PROCEDURE IF EXISTS `SP_DELETE_RANKING_EXCLUSION`;
DELIMITER $$
CREATE PROCEDURE `SP_DELETE_RANKING_EXCLUSION` (
    IN i_requester_id    INT UNSIGNED,      -- 요청자 GM 계정 ID
    IN i_ranking_id      INT UNSIGNED,      -- 랭킹 ID
    IN i_season_no       INT UNSIGNED,      -- 시즌 번호 (0:전 시즌)
    IN i_member_id       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin   -- 해제할 멤버 ID (대소문자 구분)
) COMMENT '제재 해제 (operator). 검수가 끝나기 전(REVIEW까지) 시즌과 전 시즌 제재만'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_DELETE_RANKING_EXCLUSION
    -- 작성 : 2026.10.30 trisakion
    -- 내용 : DELETE /admin/v1/rankings/{id}/exclusions/{seasonNo}/{memberId} (01_DESIGN 7.8, 10.4, D-75).
    --        RESULT: 0 성공, 1001 파라미터, 1405 권한 부족, 1501 랭킹 없음, 1603 검수가 끝난 시즌, 1604 해제할 제재 없음 [codes.SpResult]
    --        성공 데이터: 지운 행(reason, created_by, created_at, 감사 로그용), live_seasons (앱이 원장 값으로 다시 반영할 시즌,
    --                     쉼표 구분 — 지정 시즌이면 CLOSED 이하일 때 그 시즌, 전 시즌이면 그 랭킹의 CLOSED 이하 시즌 전부)
    --        - Redis(SREM → 원장 값 재반영)는 커밋 뒤 앱이 한다.
    --        - FINALIZING 이후 시즌은 순위·보상이 확정됐거나 확정 중이라 풀지 않는다(1603). 이미 붙은 sanctioned 표시는
    --          지우지 않는다(D-75). 전 시즌 제재는 언제나 풀 수 있고, 이미 확정된 시즌의 결과는 그대로다.
    --        - 시즌 행을 먼저 공유 잠금해 FINALIZING 전이(X 락)와 줄을 세운다. 전이가 먼저면 1603, 해제가 먼저면 확정이
    --          이 제재를 보지 않는다. 시즌 행이 없으면(일정 변경으로 지운 예정 시즌) 그대로 지운다.
    --        - 잠금 순서: ranking_season(3) S → ranking_exclusion(4) X.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_found            INT UNSIGNED;
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_live             TEXT;
    DECLARE v_reason           VARCHAR(255);
    DECLARE v_created_by       INT UNSIGNED;
    DECLARE v_created_at       DATETIME(3);
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
        IF i_requester_id IS NULL OR i_requester_id = 0 OR i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL
           OR i_member_id IS NULL OR CHAR_LENGTH(i_member_id) NOT BETWEEN 1 AND 64 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 2 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT ranking_id INTO v_found FROM ranking_definition WHERE ranking_id = i_ranking_id;
        IF v_found IS NULL THEN
            SELECT 1501 AS RESULT;
            LEAVE proc_block;
        END IF;

        START TRANSACTION;

        IF i_season_no > 0 THEN
            SELECT status INTO v_status FROM ranking_season
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no
               FOR SHARE;
            IF v_status > 5 THEN
                ROLLBACK;
                SELECT 1603 AS RESULT;
                LEAVE proc_block;
            END IF;
            SET v_live = IF(v_status <= 3, CAST(i_season_no AS CHAR), '');
        ELSE
            SELECT GROUP_CONCAT(season_no ORDER BY season_no) INTO v_live
              FROM ranking_season
             WHERE ranking_id = i_ranking_id AND status <= 3;
        END IF;

        SELECT reason, created_by, created_at INTO v_reason, v_created_by, v_created_at
          FROM ranking_exclusion
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id
           FOR UPDATE;
        IF v_reason IS NULL THEN
            ROLLBACK;
            SELECT 1604 AS RESULT;
            LEAVE proc_block;
        END IF;

        DELETE FROM ranking_exclusion
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id;

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT v_reason AS reason, v_created_by AS created_by, v_created_at AS created_at, IFNULL(v_live, '') AS live_seasons;
    END proc_block;
END$$
DELIMITER ;
