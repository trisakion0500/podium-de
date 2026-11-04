DROP PROCEDURE IF EXISTS `SP_LIST_REVIEW_HOLD_OVERDUE`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_REVIEW_HOLD_OVERDUE` (
    IN i_warn_sec    INT UNSIGNED    -- review_until 경과 기준(초, 1 이상)
) COMMENT '장기 보류 시즌: 보류 중인 REVIEW 시즌 중 review_until이 기준보다 오래 지난 것'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_REVIEW_HOLD_OVERDUE
    -- 작성 : 2026.11.04 trisakion
    -- 내용 : 워커 전달 잡의 장기 보류 경고가 읽는다 (01_DESIGN 7.5, D-82).
    --        RESULT: 0 성공, 1001 파라미터 [codes.SpResult]
    --        성공 데이터: ranking_id, season_no, overdue_sec (review_until 뒤로 지난 초)
    --        - 검수 기간 안의 보류는 보상을 아직 늦추지 않아 대상이 아니다.
    --        - 시각 비교는 DB 시각이다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
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
        IF i_warn_sec IS NULL OR i_warn_sec = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT ranking_id, season_no, TIMESTAMPDIFF(SECOND, review_until, v_now) AS overdue_sec
          FROM ranking_season
         WHERE status = 5 AND review_hold = 1 AND review_until < v_now - INTERVAL i_warn_sec SECOND
         ORDER BY review_until, ranking_id, season_no;
    END proc_block;
END$$
DELIMITER ;
