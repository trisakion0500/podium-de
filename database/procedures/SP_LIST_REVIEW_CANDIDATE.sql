DROP PROCEDURE IF EXISTS `SP_LIST_REVIEW_CANDIDATE`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_REVIEW_CANDIDATE` (
    IN i_ranking_id    INT UNSIGNED,         -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,         -- 시즌 번호 (1 이상, REVIEW여야 함)
    IN i_offset        INT UNSIGNED,         -- 시작 위치 (0부터)
    IN i_size          SMALLINT UNSIGNED     -- 최대 행 수 (1~100)
) COMMENT '검수 목록: 보상 구간 안에서 어뷰징 포인트나 하드 검증 거부가 있는 멤버 (포인트 내림차순)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_REVIEW_CANDIDATE
    -- 작성 : 2026.11.04 trisakion
    -- 내용 : GET /admin/v1/rankings/{id}/seasons/{n}/review (01_DESIGN 7.5, 9.3, 10.4, D-77). 역할 확인(viewer)은 앱이 한다 — 상태를 바꾸지 않는 조회라서다.
    --        RESULT: 0 성공, 1001 파라미터, 1002 시즌 없음, 1701 검수 중인 시즌이 아님 [codes.SpResult]
    --        성공 데이터: 후보 행과 total_count. 범위 밖이면 total_count만 채운 1행 — 개발 컨벤션 4.6의 LEFT JOIN ON TRUE
    --        - 구간 판정은 SP_UPDATE_FINAL_RANK와 같은 식이다(D-69). 다만 tier_snapshot이 아직 없어 지금의 구간을, 제재 전이라
    --          가순위를 쓴다. 제재로 순위가 당겨져 구간에 새로 들어오는 멤버는 나오지 않는다(D-82).
    --        - 구간 최대 순위를 먼저 구해 ix_final_rank 범위만 읽는다. 후보마다 ranking_suspicion과 ranking_submit_key를
    --          ix_member_id로 찾으므로, 시즌 전체의 거부 행을 훑지 않는다.
    --        - WITH는 한 번만 계산되어 총 개수와 페이지가 같은 후보를 본다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    --        ponytail: 비용은 보상 구간 인원에 비례한다. PERCENT 100%처럼 넓은 구간이 흔해지면 후보 요약 테이블을 둔다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_count            BIGINT UNSIGNED;
    DECLARE v_max_rank         BIGINT UNSIGNED;
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
           OR i_offset IS NULL OR i_size IS NULL OR i_size = 0 OR i_size > 100 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT status INTO v_status FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 5 THEN
            SELECT 1701 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT COUNT(member_id) INTO v_count
          FROM ranking_entry WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank IS NOT NULL;

        -- PERCENT의 누적 인원은 ceil(P × t / 100)이다(D-69). 정수 올림으로 쓴다.
        SELECT MAX(IF(range_type = 1, range_to, (range_to * v_count + 99) DIV 100)) INTO v_max_rank
          FROM ranking_reward_tier WHERE ranking_id = i_ranking_id;

        SELECT 0 AS RESULT;
        WITH in_range AS (
            SELECT e.member_id, e.final_rank, e.score,
                   (SELECT t.reward_code
                      FROM ranking_reward_tier t
                     WHERE t.ranking_id = i_ranking_id
                       AND ((t.range_type = 1 AND e.final_rank BETWEEN t.range_from AND t.range_to)
                         OR (t.range_type = 2 AND (e.final_rank - 1) * 100 >= (GREATEST(t.range_from, 1) - 1) * v_count
                                              AND (e.final_rank - 1) * 100 < t.range_to * v_count))
                     ORDER BY t.range_type, t.tier_no
                     LIMIT 1) AS reward_code
              FROM ranking_entry e
             WHERE e.ranking_id = i_ranking_id AND e.season_no = i_season_no AND e.final_rank BETWEEN 1 AND v_max_rank
        ), candidate AS (
            SELECT r.member_id, r.final_rank, r.score, r.reward_code,
                   (SELECT IFNULL(SUM(s.weight), 0) FROM ranking_suspicion s
                     WHERE s.ranking_id = i_ranking_id AND s.season_no = i_season_no AND s.member_id = r.member_id) AS points,
                   (SELECT IFNULL(SUM(s.weight), 0) FROM ranking_suspicion s
                     WHERE s.ranking_id = i_ranking_id AND s.season_no = i_season_no - 1 AND s.member_id = r.member_id) AS previous_points,
                   (SELECT COUNT(k.request_id) FROM ranking_submit_key k
                     WHERE k.ranking_id = i_ranking_id AND k.season_no = i_season_no AND k.member_id = r.member_id AND k.rejected IS NOT NULL) AS rejected_count,
                   EXISTS (SELECT 1 FROM ranking_exclusion x
                            WHERE x.ranking_id = i_ranking_id AND x.season_no IN (0, i_season_no) AND x.member_id = r.member_id) AS excluded
              FROM in_range r
             WHERE r.reward_code IS NOT NULL
            HAVING points > 0 OR rejected_count > 0
        )
        SELECT p.member_id, p.final_rank, p.score, p.reward_code, p.points, p.previous_points, p.rejected_count, p.excluded, cnt.total_count
          FROM (SELECT COUNT(member_id) AS total_count FROM candidate) cnt
          LEFT JOIN (
                SELECT member_id, final_rank, score, reward_code, points, previous_points, rejected_count, excluded
                  FROM candidate
                 ORDER BY points DESC, rejected_count DESC, final_rank
                 LIMIT i_size OFFSET i_offset
          ) p ON TRUE
         ORDER BY p.points DESC, p.rejected_count DESC, p.final_rank;
    END proc_block;
END$$
DELIMITER ;
