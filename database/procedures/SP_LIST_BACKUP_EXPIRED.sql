DROP PROCEDURE IF EXISTS `SP_LIST_BACKUP_EXPIRED`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_BACKUP_EXPIRED` (
) COMMENT '시즌 end_at + history_retention일이 지난 시즌 백업 테이블 목록 (경고용, 오래된 것부터)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_BACKUP_EXPIRED
    -- 작성 : 2026.10.20 trisakion
    -- 내용 : 워커 백업 분리 잡이 보관 기간이 지난 백업 테이블을 찾아 경고한다 (01_DESIGN 8.3). 지우지 않는다 —
    --        덤프·삭제는 운영자가 한다.
    --        - history_retention = 0은 무기한 보관이라 대상이 아니다.
    --        - 백업 이름은 시즌 행의 (ranking_id, season_no)로 만들어 information_schema.TABLES와 맞춘다. 테이블 이름을
    --          읽어 숫자로 바꾸지 않는다 (D-48). 운영자가 이름을 바꿔 둔 테이블은 맞지 않아 대상에서 빠진다.
    --        - 기한 비교는 "지금 - 보관 일수"와 end_at으로 한다. end_at + 일수로 계산하면 영구 랭킹 시즌(9999-12-31)이
    --          날짜 범위를 넘는다.
    --        - ranking_code는 경고 문구에 함께 찍어 운영자가 어떤 랭킹인지 바로 알게 한다.
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
    -- 8:SETTLED [codes.SeasonStatus]
    SELECT t.TABLE_NAME AS table_name, d.ranking_code, s.end_at
      FROM ranking_season s
      JOIN ranking_definition d ON d.ranking_id = s.ranking_id
      JOIN information_schema.TABLES t
        ON t.TABLE_SCHEMA = DATABASE()
       AND t.TABLE_NAME IN (CONCAT('ranking_entry_r', s.ranking_id, '_s', s.season_no),
                            CONCAT('ranking_submit_key_r', s.ranking_id, '_s', s.season_no))
     WHERE s.status = 8 AND d.history_retention > 0
       AND s.end_at < v_now - INTERVAL d.history_retention DAY
     ORDER BY s.end_at, t.TABLE_NAME;
END$$
DELIMITER ;
