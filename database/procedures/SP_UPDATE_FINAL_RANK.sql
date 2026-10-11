DROP PROCEDURE IF EXISTS `SP_UPDATE_FINAL_RANK`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_FINAL_RANK` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,    -- 시즌 번호 (1 이상, FINALIZING이고 participant_count가 기록되어 있어야 함)
    IN i_base          INT UNSIGNED,    -- 이미 확정한 순위 수 (커서, 첫 호출 0, 이후 앞 호출의 ranked_count를 더한 값)
    IN i_chunk         INT UNSIGNED     -- 한 번에 확정할 행 수 (1~100000)
) COMMENT 'FINALIZING 시즌의 순위를 가순위 순서로 한 청크 다시 매기고 보상을 판정, 매긴 행 수를 반환'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_FINAL_RANK
    -- 작성 : 2026.10.11 trisakion
    -- 내용 : FINALIZING 2·4단계 (01_DESIGN 7.6). 잡이 SP_UPDATE_FINAL_EXCLUSION 뒤에 i_base 0부터, ranked_count가
    --        0이 될 때까지 i_base += ranked_count로 반복해 부른다.
    --        RESULT: 0 성공, 1001 파라미터, 1002 시즌 없음, 1003 상태가 FINALIZING 아님,
    --                1015 participant_count·tier_snapshot 없음(제재 제외를 먼저 해야 함) [codes.SpResult]
    --        성공 데이터: ranked_count (0이면 끝)
    --
    --        - 커서: final_rank > i_base인 행을 final_rank 순으로 i_chunk개 읽어 i_base + 1부터 다시 매긴다.
    --          제재 행이 NULL로 빠진 자리만큼 뒤 행의 순위가 당겨지므로 새 순위는 가순위보다 크지 않다. 그래서
    --          처리한 행은 1..i_base, 남은 행은 가순위 그대로 i_base보다 크다 — 커서 이후 범위에 처리한 행이 다시
    --          나오지 않고, 섞여 있어도 final_rank 순서는 원래 가순위 순서와 같다. 정렬 인덱스 없이 ix_final_rank를 탄다.
    --        - 커서는 잡 메모리에만 있다. 중단 후에는 0부터 다시 돈다. 앞부분은 같은 값을 다시 쓰는 것이라 결과가
    --          같다(멱등). 다시 도는 비용은 한 시즌 한 바퀴다.
    --        - 보상은 새 순위로 같은 문장에서 판정한다(4단계). 한 행에 reward_code 하나라 중복 보상은 생기지 않는다.
    --          tier_snapshot에서 RANK 구간을 PERCENT보다 먼저, 같은 종류는 tier_no 순으로 보고 처음 맞는 구간을 준다.
    --          상위권을 RANK로 정확히 주는 구성(1위, 2~3위 … + 상위 10% …)에서 tier_no 순서를 잘못 넣어도 RANK가 이긴다(D-69).
    --          맞는 구간이 없으면 NULL, NONE(0). 구간 사이 빈 순위는 잡이 경고 로그로 알린다(settle.ts rewardGaps).
    --          RANK: final_rank BETWEEN range_from AND range_to
    --          PERCENT: 내 앞 사람 비율 (final_rank - 1) / participant_count가 [range_from - 1, range_to) % 안이면 그 구간이다
    --          (D-69). 1위는 앞 사람이 없어(0%) 항상 첫 구간이고, "상위 t%" 누적 인원은 ceil(P × t / 100)이다 — 경계에 걸친
    --          1명을 포함한다. 양변에 P를 곱한 정수 비교로 쓴다. 나눗셈(/)은 DECIMAL이라 중간 정밀도(소수 약 9자리) 밖의
    --          차이를 잃는다(실측 CEIL(4000000001 / 4000000000) = 1). range_from = 0은 1과 같게 본다 — UNSIGNED 뺄셈이 음수가
    --          되면 오류라 GREATEST로 막는다.
    --        - 다중 테이블 UPDATE는 SET 순서가 보장되지 않아 reward_code와 reward_status를 파생 테이블에서 함께 구한다.
    --          번호를 매기는 파생 테이블은 윈도우 함수 때문에 구체화되어 대상 테이블을 함께 읽어도 된다.
    --        - 청크 하나가 자동 커밋 한 문장이다. ranking_entry(잠금 순서 7)의 끝난 시즌 파티션만 쓰고, 제출은 시각
    --          검사로 이 파티션에 쓰지 않는다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_count            INT UNSIGNED;
    DECLARE v_tiers            JSON;
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
           OR i_base IS NULL OR i_chunk IS NULL OR i_chunk = 0 OR i_chunk > 100000 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT status, participant_count, tier_snapshot INTO v_status, v_count, v_tiers
          FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 6 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_count IS NULL OR v_tiers IS NULL THEN
            SELECT 1015 AS RESULT;
            LEAVE proc_block;
        END IF;

        -- UPDATE가 바꾼 행 수(ROW_COUNT)는 같은 값을 다시 쓴 행을 세지 않아 커서 진행에 쓸 수 없다. 읽은 행 수를 따로 센다.
        SELECT COUNT(c.member_id) INTO v_ranked
          FROM (SELECT member_id FROM ranking_entry
                 WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank > i_base
                 ORDER BY final_rank
                 LIMIT i_chunk) c;
        IF v_ranked > 0 THEN
            UPDATE ranking_entry e
              JOIN (SELECT r.member_id, r.rn,
                           (SELECT j.reward_code
                              FROM JSON_TABLE(v_tiers, '$[*]' COLUMNS (
                                       tier_no        INT            PATH '$.tier_no',
                                       range_type     INT            PATH '$.range_type',
                                       range_from     INT UNSIGNED   PATH '$.range_from',
                                       range_to       INT UNSIGNED   PATH '$.range_to',
                                       reward_code    VARCHAR(64)    PATH '$.reward_code')) j
                             WHERE (j.range_type = 1 AND r.rn BETWEEN j.range_from AND j.range_to)
                                OR (j.range_type = 2 AND (r.rn - 1) * 100 >= (GREATEST(j.range_from, 1) - 1) * v_count
                                                     AND (r.rn - 1) * 100 < j.range_to * v_count)
                             ORDER BY j.range_type, j.tier_no
                             LIMIT 1) AS reward_code
                      FROM (SELECT member_id, i_base + ROW_NUMBER() OVER (ORDER BY final_rank) AS rn
                              FROM (SELECT member_id, final_rank
                                      FROM ranking_entry
                                     WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank > i_base
                                     ORDER BY final_rank
                                     LIMIT i_chunk) c) r) t
                ON e.ranking_id = i_ranking_id AND e.season_no = i_season_no AND e.member_id = t.member_id
               SET e.final_rank = t.rn, e.reward_code = t.reward_code, e.reward_status = IF(t.reward_code IS NULL, 0, 1);
        END IF;

        SELECT 0 AS RESULT;
        SELECT v_ranked AS ranked_count;
    END proc_block;
END$$
DELIMITER ;
