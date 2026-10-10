DROP PROCEDURE IF EXISTS `SP_LIST_SEASON_PLAN`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_SEASON_PLAN` (
) COMMENT '시즌 선행 생성 대상: 종료되지 않은 랭킹별 주기 설정, 마지막 시즌, 아직 끝나지 않은 시즌 수, DB 시각'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_SEASON_PLAN
    -- 작성 : 2026.10.10 trisakion
    -- 내용 : 워커 스케줄러(01_DESIGN 3.3)가 주기마다 읽어 시즌 행을 "현재 + 다음 2개"까지 미리 만든다.
    --        - 다음 시즌의 시각 계산(timezone 달력 경계)은 앱이 한다. MySQL CONVERT_TZ는 시간대 테이블 적재가
    --          설치마다 필요해서다. SP는 계산 재료만 돌려준다.
    --        - ENDED(3) 랭킹은 새 시즌을 만들지 않으므로 뺀다. PAUSED는 시간이 흐르므로 계속 만든다.
    --        - ahead_count는 end_at이 DB 시각보다 뒤인 시즌 수다(진행 중 + 예정). 3보다 작으면 앱이 채운다.
    --        - db_now는 ahead_count 판단에 쓴 시각이다. 앱 시계가 아니라 DB 시계로 판단해 SP의 시각 검사와 맞춘다.
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
    -- ponytail: 랭킹마다 ranking_season을 PK 범위로 두 번 읽는다. 랭킹이 수천 개가 되면 한 번의 GROUP BY로 합친다.
    SELECT d.ranking_id, d.timezone, d.start_at, d.end_at, d.cycle_type, d.cycle_value, d.wait_period,
           l.season_no AS last_season_no, l.start_at AS last_start_at, l.end_at AS last_end_at,
           (SELECT COUNT(*) FROM ranking_season a WHERE a.ranking_id = d.ranking_id AND a.end_at > v_now) AS ahead_count,
           v_now AS db_now
      FROM ranking_definition d
      LEFT JOIN ranking_season l
             ON l.ranking_id = d.ranking_id
            AND l.season_no = (SELECT MAX(m.season_no) FROM ranking_season m WHERE m.ranking_id = d.ranking_id)
     WHERE d.status <> 3
     ORDER BY d.ranking_id;
END$$
DELIMITER ;
