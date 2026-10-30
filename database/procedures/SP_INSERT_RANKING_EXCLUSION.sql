DROP PROCEDURE IF EXISTS `SP_INSERT_RANKING_EXCLUSION`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_RANKING_EXCLUSION` (
    IN i_requester_id    INT UNSIGNED,      -- 요청자 GM 계정 ID
    IN i_ranking_id      INT UNSIGNED,      -- 랭킹 ID
    IN i_season_no       INT UNSIGNED,      -- 시즌 번호 (0:전 시즌)
    IN i_member_id       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,  -- 제재할 멤버 ID (대소문자 구분)
    IN i_reason          VARCHAR(255)       -- 제재 사유 (1~255자)
) COMMENT '제재 등록 (operator). DELIVERING 이후 시즌이면 sanctioned 표시까지'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_RANKING_EXCLUSION
    -- 작성 : 2026.10.30 trisakion
    -- 내용 : POST /admin/v1/rankings/{id}/exclusions (01_DESIGN 7.8, 10.4, D-75, D-78).
    --        RESULT: 0 성공, 1001 파라미터, 1405 권한 부족, 1501 랭킹 없음, 1601 이미 같은 제재, 1602 시즌 없음 [codes.SpResult]
    --        성공 데이터: season_status (지정 시즌의 상태, 전 시즌은 NULL), live_seasons (Redis 순위표가 있을 수 있는 시즌 번호,
    --                     쉼표 구분 — 지정 시즌이면 그 시즌만, 전 시즌이면 그 랭킹의 CLOSED 이하 시즌 전부), created_at
    --        - Redis(SADD → ZREM)는 커밋 뒤 앱이 한다. live_seasons는 앱이 ZREM할 순위표를 고르는 데 쓴다.
    --        - 순위·보상에 주는 영향은 시즌 상태로 정해진다(7.8).
    --            REVIEW까지: 기록만 한다. 확정(SP_UPDATE_FINAL_EXCLUSION)이 review_until 전 등록분을 제외한다.
    --            FINALIZING: 기록만 한다. 검수 뒤 제재라 DELIVERING 전이가 sanctioned를 붙인다.
    --            DELIVERING 이후: 여기서 entry와 Top N에 sanctioned = 1을 붙인다. 분리된 시즌은 entry 행이 없어 Top N에만 붙는다.
    --          전 시즌(0) 제재의 표시는 지금 DELIVERING인 시즌에만 붙인다. SETTLED인 과거 시즌은 그 시즌을 지정해 등록한다.
    --        - 시즌 행을 먼저 공유 잠금한다. DELIVERING 전이(X 락)와 줄을 세워, 전이가 읽기 전에 등록하면 전이가 표시하고
    --          전이 뒤에 등록하면 여기서 표시한다 — 어느 쪽에서도 빠지지 않는다(D-78). 전 시즌은 그 랭킹의 시즌 행 전체를 잠근다.
    --          잠그는 동안 스케줄러 상태 전이가 기다리지만 트랜잭션이 짧다.
    --        - 중복은 INSERT IGNORE + ROW_COUNT로 판정한다. 길이는 앞에서 검사해 IGNORE가 잘림을 경고로 숨기지 않게 한다.
    --        - 잠금 순서: ranking_season(3) S → ranking_exclusion(4) X → ranking_entry(7) X → ranking_season_top(9) X.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_found            INT UNSIGNED;
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_live             TEXT;
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
           OR i_member_id IS NULL OR CHAR_LENGTH(i_member_id) NOT BETWEEN 1 AND 64
           OR i_reason IS NULL OR CHAR_LENGTH(i_reason) NOT BETWEEN 1 AND 255 THEN
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
            IF v_status IS NULL THEN
                ROLLBACK;
                SELECT 1602 AS RESULT;
                LEAVE proc_block;
            END IF;
            SET v_live = IF(v_status <= 3, CAST(i_season_no AS CHAR), '');
        ELSE
            SELECT GROUP_CONCAT(IF(status <= 3, season_no, NULL) ORDER BY season_no) INTO v_live
              FROM ranking_season
             WHERE ranking_id = i_ranking_id
               FOR SHARE;
        END IF;

        INSERT IGNORE INTO ranking_exclusion (ranking_id, season_no, member_id, reason, created_by, created_at)
        VALUES (i_ranking_id, i_season_no, i_member_id, i_reason, i_requester_id, v_now);
        IF ROW_COUNT() = 0 THEN
            ROLLBACK;
            SELECT 1601 AS RESULT;
            LEAVE proc_block;
        END IF;

        IF i_season_no > 0 AND v_status >= 7 THEN
            UPDATE ranking_entry SET sanctioned = 1
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id AND sanctioned = 0;
            UPDATE ranking_season_top SET sanctioned = 1
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id AND sanctioned = 0;
        ELSEIF i_season_no = 0 THEN
            UPDATE ranking_entry e
              JOIN ranking_season s ON s.ranking_id = e.ranking_id AND s.season_no = e.season_no AND s.status = 7
               SET e.sanctioned = 1
             WHERE e.ranking_id = i_ranking_id AND e.member_id = i_member_id AND e.sanctioned = 0;
            UPDATE ranking_season_top t
              JOIN ranking_season s ON s.ranking_id = t.ranking_id AND s.season_no = t.season_no AND s.status = 7
               SET t.sanctioned = 1
             WHERE t.ranking_id = i_ranking_id AND t.member_id = i_member_id AND t.sanctioned = 0;
        END IF;

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT IF(i_season_no > 0, v_status, NULL) AS season_status, IFNULL(v_live, '') AS live_seasons, v_now AS created_at;
    END proc_block;
END$$
DELIMITER ;
