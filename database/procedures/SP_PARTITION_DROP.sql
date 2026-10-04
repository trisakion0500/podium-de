DROP PROCEDURE IF EXISTS `SP_PARTITION_DROP`;
DELIMITER $$
CREATE PROCEDURE `SP_PARTITION_DROP` (
    IN i_target        TINYINT UNSIGNED,    -- 대상 테이블 (1:ranking_entry, 2:ranking_submit_key) [codes.PartitionTarget]
    IN i_ranking_id    INT UNSIGNED,        -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED         -- 시즌 번호 (1 이상)
) COMMENT '비어 있는 시즌 파티션만 삭제. 행이 있으면 거부, 없으면 성공 (멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_PARTITION_DROP
    -- 작성 : 2026.10.04 trisakion
    -- 내용 : 01_DESIGN 8.2 EXCHANGE 절차의 4단계. 운영 테이블에서 데이터가 든 파티션을 DROP하면 배타 MDL을 쥔 채
    --        파일 삭제가 진행되므로(8.1), 비어 있는 파티션만 삭제한다. 데이터는 먼저 SP_PARTITION_EXCHANGE로 백업에 보낸다.
    --        - 삭제 직전 행 유무를 검증하고 행이 있으면 1006으로 거부한다 (11.3 파괴적 작업 직전 검증).
    --          (ranking_id, season_no) 조건이 곧 파티션 하나이고 PK 접두라 행 하나만 읽는다.
    --        - 시즌 행이 있으면 SETTLED일 때만 허용한다. 진행 중 시즌의 빈 파티션을 지우면 이후 제출 INSERT가
    --          "파티션 없음" 오류로 실패한다. 시즌 행이 없는 파티션(고아)은 상태와 무관하게 비어 있으면 지운다.
    --        - 확인과 DROP 사이에 행이 들어올 여지: SETTLED 시즌은 제출 SP의 시각 검사로 쓰기가 없고,
    --          아카이브 잡은 GET_LOCK으로 한 곳에서만 돈다. 그래서 별도 잠금 없이 확인 후 삭제한다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_table            VARCHAR(64);
    DECLARE v_partition        VARCHAR(64);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_has_rows         TINYINT(1)      DEFAULT 0;
    DECLARE sql_state          CHAR(5)         DEFAULT '00000';
    DECLARE error_no           INT             DEFAULT 0;
    DECLARE error_message      VARCHAR(512)    DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        ROLLBACK;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    proc_block: BEGIN
        IF i_target IS NULL OR i_target NOT IN (1, 2)
           OR i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_status = (SELECT status FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no);
        -- 8:SETTLED [codes.SeasonStatus]
        IF v_status IS NOT NULL AND v_status <> 8 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_table = IF(i_target = 1, 'ranking_entry', 'ranking_submit_key');
        SET v_partition = CONCAT('p_r', i_ranking_id, '_s', i_season_no);

        IF NOT EXISTS (SELECT 1 FROM information_schema.PARTITIONS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = v_table AND PARTITION_NAME = v_partition) THEN
            SELECT 0 AS RESULT;
            SELECT 0 AS dropped;
            LEAVE proc_block;
        END IF;

        IF i_target = 1 THEN
            SET v_has_rows = EXISTS (SELECT 1 FROM ranking_entry WHERE ranking_id = i_ranking_id AND season_no = i_season_no);
        ELSE
            SET v_has_rows = EXISTS (SELECT 1 FROM ranking_submit_key WHERE ranking_id = i_ranking_id AND season_no = i_season_no);
        END IF;
        IF v_has_rows = 1 THEN
            SELECT 1006 AS RESULT;
            LEAVE proc_block;
        END IF;

        CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `', v_table, '` DROP PARTITION `', v_partition, '`'));

        SELECT 0 AS RESULT;
        SELECT 1 AS dropped;
    END proc_block;
END$$
DELIMITER ;
