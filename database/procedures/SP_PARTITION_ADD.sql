DROP PROCEDURE IF EXISTS `SP_PARTITION_ADD`;
DELIMITER $$
CREATE PROCEDURE `SP_PARTITION_ADD` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED     -- 시즌 번호 (1 이상, ranking_season에 행이 있어야 함)
) COMMENT '시즌 파티션을 ranking_entry, ranking_submit_key에 추가. 이미 있으면 건너뜀 (멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_PARTITION_ADD
    -- 작성 : 2026.10.04 trisakion
    -- 내용 : 시즌 행 생성 후 두 파티션 테이블에 p_r{id}_s{n} 파티션을 추가한다 (01_DESIGN 3.3, 11.2).
    --        - 파티션 이름과 값은 INT UNSIGNED 파라미터로만 조립한다. 숫자 외 문자가 들어갈 수 없다 (D-25).
    --        - 0은 받지 않는다. (0, 0)은 초기 파티션 p_init 값이다.
    --        - 시즌 행이 없으면 거부한다. 테이블당 파티션 상한(8192)이 있어 잘못된 호출로 빈 파티션이 쌓이면 안 된다.
    --        - 테이블마다 존재를 확인하고 없을 때만 추가하므로, 한쪽만 추가된 채 중단되어도 다시 호출하면 나머지를 채운다.
    --        - 확인과 추가 사이에 다른 세션이 먼저 추가하면 1517(같은 이름 파티션)이 난다. 결과가 같으므로 성공으로 본다.
    --          이 경우 log_ddl_audit에는 FAILED가 남는다. 잡은 GET_LOCK으로 직렬화되므로 실제로는 수동 호출과 겹칠 때만 생긴다.
    --        - ADD PARTITION은 메타데이터 변경이지만 배타 MDL이 필요하다. 대기 제한은 SP_EXEC_DDL이 건다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_partition        VARCHAR(64);
    DECLARE v_values           VARCHAR(64);
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no) THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_partition = CONCAT('p_r', i_ranking_id, '_s', i_season_no);
        SET v_values = CONCAT('((', i_ranking_id, ', ', i_season_no, '))');

        IF NOT EXISTS (SELECT 1 FROM information_schema.PARTITIONS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry' AND PARTITION_NAME = v_partition) THEN
            BEGIN
                DECLARE CONTINUE HANDLER FOR 1517 BEGIN END;
                CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `ranking_entry` ADD PARTITION (PARTITION `', v_partition, '` VALUES IN ', v_values, ')'));
            END;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.PARTITIONS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_submit_key' AND PARTITION_NAME = v_partition) THEN
            BEGIN
                DECLARE CONTINUE HANDLER FOR 1517 BEGIN END;
                CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `ranking_submit_key` ADD PARTITION (PARTITION `', v_partition, '` VALUES IN ', v_values, ')'));
            END;
        END IF;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
