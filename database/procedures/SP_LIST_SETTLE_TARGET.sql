DROP PROCEDURE IF EXISTS `SP_LIST_SETTLE_TARGET`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_SETTLE_TARGET` (
) COMMENT '정산 잡 대상: settle_at이 지난 CLOSED, 진행 중인 SETTLING, 검수가 끝난 REVIEW, 진행 중인 FINALIZING (settle_at 순)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_SETTLE_TARGET
    -- 작성 : 2026.10.10 trisakion
    -- 수정 : 2026.10.11 trisakion REVIEW(review_until 경과, 보류 없음)와 FINALIZING 추가 (7.5, 7.6)
    -- 내용 : 워커 정산 잡(01_DESIGN 7.1, 7.3, 7.6)이 주기마다 읽는다.
    --        - SETTLING(4)·FINALIZING(6)을 함께 돌려준다. 도중에 워커가 죽었으면 다음 워커가 이어서 진행한다(8.6).
    --        - REVIEW(5)는 review_until이 지났고 review_hold = 0인 것만이다. 전이 SP가 같은 조건을 다시 본다.
    --        - settle_at 순으로 처리한다. 먼저 끝난 시즌이 먼저 정산되어야 다음 시즌 정산과 겹치지 않는다(2.7).
    --        - 시각 비교는 DB 시각이다. 나머지 시작 조건(미종료 트랜잭션, 동기화 시각)은 SP_START_SETTLING이 본다.
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

    SELECT 0 AS RESULT;
    -- ponytail: 상태 조건으로 전체를 훑는다. 시즌 행이 수십만이 되면 (status, settle_at) 인덱스를 둔다.
    SELECT ranking_id, season_no, status, end_at, settle_at, v_now AS db_now
      FROM ranking_season
     WHERE (status = 3 AND settle_at <= v_now) OR status IN (4, 6)
        OR (status = 5 AND review_hold = 0 AND review_until <= v_now)
     ORDER BY settle_at, ranking_id, season_no;
END$$
DELIMITER ;
