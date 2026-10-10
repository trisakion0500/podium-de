DROP PROCEDURE IF EXISTS `SP_UPDATE_SETTLING_RANK`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_SETTLING_RANK` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,    -- 시즌 번호 (1 이상, SETTLING이고 작업 테이블에 꺼내져 있어야 함)
    IN i_chunk         INT UNSIGNED     -- 한 번에 매길 행 수 (1~100000)
) COMMENT 'ranking_entry_settling에서 가순위(final_rank)를 정렬 인덱스 순서로 한 청크 매기고 매긴 행 수를 반환'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_SETTLING_RANK
    -- 작성 : 2026.10.10 trisakion
    -- 내용 : SETTLING 3단계 가순위 UPDATE (01_DESIGN 7.3). 잡이 0행이 나올 때까지 반복해 부른다.
    --        RESULT: 0 성공, 1001 파라미터, 1002 시즌 없음, 1003 SETTLING 아님, 1012 작업 테이블에 이 시즌이 없거나
    --                정렬 컬럼이 없음 (SP_SETTLING_EXCHANGE가 OUT을 돌려준 뒤에 불러야 한다) [codes.SpResult]
    --        성공 데이터: ranked_count (0이면 끝)
    --
    --        - 정렬은 Redis 순서와 같다(7.3, D-57). DESC: score DESC, settle_slot ASC, member_id DESC /
    --          ASC: score ASC, settle_slot ASC, member_id ASC. settle_slot은 SP_SETTLING_EXCHANGE가 만든 가상 컬럼(시간 슬롯)이고,
    --          정렬 인덱스 ix_settle_order가 이 순서라 청크마다 인덱스 앞부분만 읽는다 (D-65).
    --        - 커서는 이미 매긴 가장 큰 final_rank 행의 정렬 키다. 중단 후 다시 불러도 그 다음부터 이어진다(멱등).
    --          순서대로 매기므로 커서 뒤의 행은 모두 final_rank가 NULL이다.
    --        - 커서 조건은 정렬 방향이 섞여 있어 튜플 비교 대신 OR로 풀어 쓴다.
    --        - LIMIT을 안쪽에 둔다. 윈도우 함수는 LIMIT보다 먼저 계산되므로, 같은 단계에 두면 청크마다 커서 이후 전체
    --          행에 번호를 매긴다. 번호를 매기는 파생 테이블은 윈도우 함수 때문에 구체화되어 대상 테이블을 함께 읽어도 된다.
    --        - 청크 하나가 자동 커밋 한 문장이다. 단일 대형 UPDATE의 언두 증가, 복제 지연을 피한다.
    --          ranking_entry_settling(잠금 순서 8)만 쓴다. 운영 테이블이 아니라 제출과 겹치지 않는다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_sort_order       TINYINT UNSIGNED;
    DECLARE v_base             INT UNSIGNED;
    DECLARE v_score            BIGINT UNSIGNED;
    DECLARE v_slot             BIGINT;
    DECLARE v_member           VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
    DECLARE v_ranked           INT UNSIGNED    DEFAULT 0;
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
           OR i_chunk IS NULL OR i_chunk = 0 OR i_chunk > 100000 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT s.status, d.sort_order INTO v_status, v_sort_order
          FROM ranking_season s
          JOIN ranking_definition d ON d.ranking_id = s.ranking_id
         WHERE s.ranking_id = i_ranking_id AND s.season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 4 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND COLUMN_NAME = 'settle_slot')
           OR NOT EXISTS (SELECT 1 FROM ranking_entry_settling WHERE ranking_id = i_ranking_id AND season_no = i_season_no) THEN
            SELECT 1012 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT MAX(final_rank) INTO v_base
          FROM ranking_entry_settling WHERE ranking_id = i_ranking_id AND season_no = i_season_no;

        -- 정렬 방향 2:ASC [codes.SortOrder]. 그 외는 DESC. 각 방향에 첫 청크(커서 없음)와 이어지는 청크 두 문장을 둔다.
        IF v_base IS NULL THEN
            SET v_base = 0;
            IF v_sort_order = 2 THEN
                UPDATE ranking_entry_settling s
                  JOIN (SELECT member_id, v_base + ROW_NUMBER() OVER (ORDER BY score ASC, settle_slot ASC, member_id ASC) AS rn
                          FROM (SELECT member_id, score, settle_slot
                                  FROM ranking_entry_settling
                                 WHERE ranking_id = i_ranking_id AND season_no = i_season_no
                                 ORDER BY score ASC, settle_slot ASC, member_id ASC
                                 LIMIT i_chunk) c) t
                    ON s.ranking_id = i_ranking_id AND s.season_no = i_season_no AND s.member_id = t.member_id
                   SET s.final_rank = t.rn;
            ELSE
                UPDATE ranking_entry_settling s
                  JOIN (SELECT member_id, v_base + ROW_NUMBER() OVER (ORDER BY score DESC, settle_slot ASC, member_id DESC) AS rn
                          FROM (SELECT member_id, score, settle_slot
                                  FROM ranking_entry_settling
                                 WHERE ranking_id = i_ranking_id AND season_no = i_season_no
                                 ORDER BY score DESC, settle_slot ASC, member_id DESC
                                 LIMIT i_chunk) c) t
                    ON s.ranking_id = i_ranking_id AND s.season_no = i_season_no AND s.member_id = t.member_id
                   SET s.final_rank = t.rn;
            END IF;
            SET v_ranked = ROW_COUNT();
        ELSE
            SELECT score, settle_slot, member_id INTO v_score, v_slot, v_member
              FROM ranking_entry_settling
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank = v_base;
            IF v_sort_order = 2 THEN
                UPDATE ranking_entry_settling s
                  JOIN (SELECT member_id, v_base + ROW_NUMBER() OVER (ORDER BY score ASC, settle_slot ASC, member_id ASC) AS rn
                          FROM (SELECT member_id, score, settle_slot
                                  FROM ranking_entry_settling
                                 WHERE ranking_id = i_ranking_id AND season_no = i_season_no
                                   AND (score > v_score
                                        OR (score = v_score AND (settle_slot > v_slot
                                                                 OR (settle_slot = v_slot AND member_id > v_member))))
                                 ORDER BY score ASC, settle_slot ASC, member_id ASC
                                 LIMIT i_chunk) c) t
                    ON s.ranking_id = i_ranking_id AND s.season_no = i_season_no AND s.member_id = t.member_id
                   SET s.final_rank = t.rn;
            ELSE
                UPDATE ranking_entry_settling s
                  JOIN (SELECT member_id, v_base + ROW_NUMBER() OVER (ORDER BY score DESC, settle_slot ASC, member_id DESC) AS rn
                          FROM (SELECT member_id, score, settle_slot
                                  FROM ranking_entry_settling
                                 WHERE ranking_id = i_ranking_id AND season_no = i_season_no
                                   AND (score < v_score
                                        OR (score = v_score AND (settle_slot > v_slot
                                                                 OR (settle_slot = v_slot AND member_id < v_member))))
                                 ORDER BY score DESC, settle_slot ASC, member_id DESC
                                 LIMIT i_chunk) c) t
                    ON s.ranking_id = i_ranking_id AND s.season_no = i_season_no AND s.member_id = t.member_id
                   SET s.final_rank = t.rn;
            END IF;
            SET v_ranked = ROW_COUNT();
        END IF;

        SELECT 0 AS RESULT;
        SELECT v_ranked AS ranked_count;
    END proc_block;
END$$
DELIMITER ;
