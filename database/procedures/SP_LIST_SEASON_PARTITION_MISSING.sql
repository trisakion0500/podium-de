DROP PROCEDURE IF EXISTS `SP_LIST_SEASON_PARTITION_MISSING`;
DELIMITER $$
CREATE PROCEDURE `SP_LIST_SEASON_PARTITION_MISSING` (
) COMMENT '아직 끝나지 않은 시즌 중 ranking_entry 또는 ranking_submit_key 파티션이 없는 시즌 목록'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_LIST_SEASON_PARTITION_MISSING
    -- 작성 : 2026.10.10 trisakion
    -- 내용 : 워커 스케줄러가 시즌 행 생성 뒤 파티션 추가가 빠진 시즌을 찾는다 (01_DESIGN 3.3, 11.3).
    --        - 시즌 INSERT(커밋)와 파티션 DDL은 한 트랜잭션이 될 수 없어, 사이에 워커가 죽으면 파티션 없는 시즌이 남는다.
    --          매 주기 이 목록으로 채워 "시작 60초 전 시즌 행과 파티션" 전제(D-60)를 지킨다.
    --        - 아직 끝나지 않은 시즌(end_at > 지금)만 본다. 끝난 시즌은 제출이 시각 검사로 막혀 행이 들어올 수 없으므로
    --          파티션이 필요 없다 — 정산과 아카이브는 파티션 없는 시즌을 빈 시즌으로 처리한다(3.3, D-63).
    --          파티션 없이 끝난 시즌은 그동안의 제출이 파티션 없음으로 실패했으므로 역시 빈 시즌이다.
    --        - information_schema.PARTITIONS는 데이터 사전에서 읽어 행 수와 무관하다. 대상은 진행 중·예정 시즌뿐이라 적다.
    --        - start_at은 앱이 시작 60초 안쪽인데 파티션이 없으면 경고하는 데 쓴다.
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
    SELECT s.ranking_id, s.season_no, s.start_at
      FROM ranking_season s
     WHERE s.status <= 2 AND s.end_at > v_now
       AND (NOT EXISTS (SELECT 1 FROM information_schema.PARTITIONS p
                         WHERE p.TABLE_SCHEMA = DATABASE() AND p.TABLE_NAME = 'ranking_entry'
                           AND p.PARTITION_NAME = CONCAT('p_r', s.ranking_id, '_s', s.season_no))
            OR NOT EXISTS (SELECT 1 FROM information_schema.PARTITIONS p
                            WHERE p.TABLE_SCHEMA = DATABASE() AND p.TABLE_NAME = 'ranking_submit_key'
                              AND p.PARTITION_NAME = CONCAT('p_r', s.ranking_id, '_s', s.season_no)))
     ORDER BY s.ranking_id, s.season_no;
END$$
DELIMITER ;
