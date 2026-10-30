DROP PROCEDURE IF EXISTS `SP_LIST_RANKING_EXCLUSION`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_RANKING_EXCLUSION` (
    IN i_ranking_id    INT UNSIGNED,         -- 랭킹 ID
    IN i_season_no     INT UNSIGNED,         -- 시즌 번호 필터 (NULL:전체, 0:전 시즌 제재만)
    IN i_member_id     VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,  -- 멤버 ID 필터 (NULL:전체, 대소문자 구분)
    IN i_offset        INT UNSIGNED,         -- 시작 위치 (0부터)
    IN i_size          SMALLINT UNSIGNED     -- 최대 행 수 (1~100)
) COMMENT '제재 목록 페이징 (최신 등록순, 등록자 지금 이름 포함)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_RANKING_EXCLUSION
    -- 작성 : 2026.10.30 trisakion
    -- 내용 : GET /admin/v1/rankings/{id}/exclusions (01_DESIGN 10.4). 역할 확인(viewer)은 앱이 한다 — 상태를 바꾸지 않는 조회라서다.
    --        RESULT: 0 성공, 1001 파라미터, 1501 랭킹 없음 [codes.SpResult]
    --        성공 데이터: 제재 행과 total_count. 범위 밖이면 total_count만 채운 1행 — 개발 컨벤션 4.6의 LEFT JOIN ON TRUE
    --        - created_by_name은 등록한 계정의 지금 이름이다(0은 SYSTEM). 계정은 지우지 않으므로 조인이 비지 않는다.
    --          등록 당시 이름은 감사 로그에 있다.
    --        - 제재는 랭킹당 많아야 수천 건이라 PK 범위를 읽고 created_at으로 정렬한다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_found            INT UNSIGNED;
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_offset IS NULL OR i_size IS NULL OR i_size = 0 OR i_size > 100 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT ranking_id INTO v_found FROM ranking_definition WHERE ranking_id = i_ranking_id;
        IF v_found IS NULL THEN
            SELECT 1501 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT p.season_no, p.member_id, p.reason, p.created_by, p.created_by_name, p.created_at, cnt.total_count
          FROM (SELECT COUNT(member_id) AS total_count
                  FROM ranking_exclusion
                 WHERE ranking_id = i_ranking_id
                   AND (i_season_no IS NULL OR season_no = i_season_no)
                   AND (i_member_id IS NULL OR member_id = i_member_id)) cnt
          LEFT JOIN (
                SELECT x.season_no, x.member_id, x.reason, x.created_by,
                       IF(x.created_by = 0, 'SYSTEM', a.display_name) AS created_by_name, x.created_at
                  FROM ranking_exclusion x
                  LEFT JOIN admin_account a ON a.admin_account_id = x.created_by
                 WHERE x.ranking_id = i_ranking_id
                   AND (i_season_no IS NULL OR x.season_no = i_season_no)
                   AND (i_member_id IS NULL OR x.member_id = i_member_id)
                 ORDER BY x.created_at DESC, x.season_no, x.member_id
                 LIMIT i_size OFFSET i_offset
          ) p ON TRUE
         ORDER BY p.created_at DESC, p.season_no, p.member_id;
    END proc_block;
END$$
DELIMITER ;
