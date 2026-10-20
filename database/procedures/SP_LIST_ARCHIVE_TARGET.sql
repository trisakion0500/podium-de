DROP PROCEDURE IF EXISTS `SP_LIST_ARCHIVE_TARGET`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_ARCHIVE_TARGET` (
) COMMENT 'SETTLED 시즌 중 ranking_entry 또는 ranking_submit_key에 시즌 파티션이 남은 시즌 목록 (백업 분리 대상)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_ARCHIVE_TARGET
    -- 작성 : 2026.10.20 trisakion
    -- 내용 : 워커 백업 분리 잡이 운영 테이블에서 백업 테이블로 옮길 시즌을 찾는다 (01_DESIGN 8.2, 11.1).
    --        - 후보만 고른다. 분리 조건(entry는 다음 시즌도 SETTLED, D-52)은 SP_PARTITION_EXCHANGE가 다시 확인하고
    --          아직이면 1004로 돌려준다. 조건을 두 곳에 나눠 쓰지 않기 위해서다.
    --        - 파티션 이름은 (ranking_id, season_no)에서 만들어 information_schema.PARTITIONS와 맞춘다. 이름을 읽어
    --          숫자로 바꾸지 않는다 (D-48).
    --        - SETTLED 시즌 전체를 훑는다. 상태 인덱스가 없지만 1시간 주기이고 시즌 행은 랭킹당 주기 수만큼만 늘어난다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
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
    SELECT s.ranking_id, s.season_no
      FROM ranking_season s
     WHERE s.status = 8
       AND EXISTS (SELECT 1 FROM information_schema.PARTITIONS p
                    WHERE p.TABLE_SCHEMA = DATABASE() AND p.TABLE_NAME IN ('ranking_entry', 'ranking_submit_key')
                      AND p.PARTITION_NAME = CONCAT('p_r', s.ranking_id, '_s', s.season_no))
     ORDER BY s.ranking_id, s.season_no;
END$$
DELIMITER ;
