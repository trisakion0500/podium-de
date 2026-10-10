DROP PROCEDURE IF EXISTS `SP_UPDATE_SEASON_REVIEW`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_SEASON_REVIEW` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED     -- 시즌 번호 (1 이상, SETTLING이고 가순위를 되돌린 뒤여야 함)
) COMMENT '가순위가 운영 테이블로 돌아온 SETTLING 시즌을 REVIEW로 전이하고 review_until = NOW + review_period'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_SEASON_REVIEW
    -- 작성 : 2026.10.10 trisakion
    -- 내용 : SETTLING 7단계 (01_DESIGN 7.3). 잡이 되돌리기(SP_SETTLING_EXCHANGE RETURNED)와 Redis 시즌 키 삭제 뒤에 부른다.
    --        RESULT: 0 성공(이미 REVIEW 이후 포함), 1001 파라미터, 1002 시즌 없음, 1003 상태가 SETTLING 아님,
    --                1013 가순위 미완료(entry에 final_rank NULL 행 또는 작업 테이블에 이 시즌 행) [codes.SpResult]
    --
    --        - 가순위가 다 돌아왔는지 다시 확인한다. 작업 테이블에 남아 있거나 NULL 행이 있으면 전이하지 않는다 —
    --          REVIEW 이후에는 final_rank NULL이 "제재 제외"를 뜻하게 되어(8.6) 미산정과 구분할 수 없다.
    --          ix_final_rank (ranking_id, season_no, final_rank)로 NULL 행 하나만 찾는다.
    --        - review_until은 전이 시각 기준이다. 검수 기간은 가순위가 나온 뒤부터 센다(7.5).
    --        - 상태전이: WHERE status = 4인 조건부 UPDATE. 이미 REVIEW 이후면 성공으로 본다(재시도 멱등).
    --        - 단독 자동 커밋 한 문장이다. ranking_season(잠금 순서 3)만 쓴다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_review_period    INT UNSIGNED;
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT s.status, d.review_period INTO v_status, v_review_period
          FROM ranking_season s
          JOIN ranking_definition d ON d.ranking_id = s.ranking_id
         WHERE s.ranking_id = i_ranking_id AND s.season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status > 4 THEN
            SELECT 0 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 4 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        IF EXISTS (SELECT 1 FROM ranking_entry_settling WHERE ranking_id = i_ranking_id AND season_no = i_season_no)
           OR EXISTS (SELECT 1 FROM ranking_entry
                       WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank IS NULL) THEN
            SELECT 1013 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE ranking_season SET status = 5, review_until = v_now + INTERVAL v_review_period SECOND
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND status = 4;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
