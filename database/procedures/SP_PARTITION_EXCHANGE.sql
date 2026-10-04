DROP PROCEDURE IF EXISTS `SP_PARTITION_EXCHANGE`;
DELIMITER $$
CREATE PROCEDURE `SP_PARTITION_EXCHANGE` (
    IN i_target        TINYINT UNSIGNED,    -- 대상 테이블 (1:ranking_entry, 2:ranking_submit_key) [codes.PartitionTarget]
    IN i_ranking_id    INT UNSIGNED,        -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED         -- 시즌 번호 (1 이상)
) COMMENT '시즌 파티션을 백업 테이블 {원본}_r{id}_s{n}로 분리 (백업 생성 → 파티션 해제 → EXCHANGE, 멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_PARTITION_EXCHANGE
    -- 작성 : 2026.10.04 trisakion
    -- 내용 : 01_DESIGN 8.2 EXCHANGE 절차의 1~3단계. 4단계(빈 파티션 DROP)는 SP_PARTITION_DROP이 한다.
    --        - 분리 시점을 SP가 다시 확인한다(방어적 이중 체크). 잡의 판단 오류로 이른 분리가 일어나면 보상 API가
    --          PENDING을 읽지 못하거나(entry) 재전송 판정이 틀어진다(submit_key).
    --            ranking_submit_key: 자기 시즌 SETTLED
    --            ranking_entry     : 자기 시즌과 다음 시즌(season_no + 1) 모두 SETTLED.
    --                                다음 시즌이 생길 수 없는 마지막 시즌은 자기 시즌 SETTLED만으로 분리한다 (D-52).
    --                                마지막 시즌 = 다음 시즌 행이 없고, 랭킹이 반복 없음(cycle_type 0) 또는 종료(status 3)
    --                                또는 랭킹 end_at이 이 시즌 end_at 이하. 다음 시즌 행이 아직 안 만들어졌을 뿐인
    --                                반복 랭킹(스케줄러 지연)은 마지막 시즌이 아니므로 1004로 기다린다.
    --        - 파티션이 없거나 비어 있으면 교환하지 않고 성공(exchanged = 0)을 돌려준다. 이미 교환했거나 참가자가 없는 시즌이다.
    --          교환은 맞바꾸기이므로, 이미 교환한 뒤 다시 교환하면 백업의 데이터가 운영 테이블로 돌아온다. 그래서
    --          "파티션이 비었으면 교환하지 않음"이 재실행 안전성의 핵심이다. 백업 테이블 쪽은 이름이 동적이라
    --          정적 SQL로 읽을 수 없어(통계 TABLE_ROWS는 근사치라 판단에 쓰지 않는다) 운영 파티션만 보고 판단한다.
    --        - 백업 테이블은 LIKE로 만들어 파티션 정의까지 복사되므로 REMOVE PARTITIONING으로 일반 테이블로 바꾼다.
    --          갓 만든 빈 테이블이라 즉시 끝난다. 이 사이에 끊겨도 다음 호출이 파티션 여부를 보고 이어서 한다.
    --        - 교환은 기본 검증(WITH VALIDATION)을 쓴다. 검증 대상은 백업(일반) 테이블의 행이고 비어 있으므로 비용이 없다.
    --          만에 하나 백업에 행이 있었다면 검증이 다른 시즌 행을 막고, 같은 시즌 행이면 맞바꿔질 뿐 사라지지 않는다.
    --          이후 SP_PARTITION_DROP이 비어 있지 않은 파티션의 삭제를 거부하므로 데이터가 유실되지 않는다.
    --        - 운영 테이블에 걸리는 것은 메타데이터 수준의 배타 MDL뿐이다. 대기 제한은 SP_EXEC_DDL이 건다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_table            VARCHAR(64);
    DECLARE v_backup           VARCHAR(64);
    DECLARE v_partition        VARCHAR(64);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_next_status      TINYINT UNSIGNED;
    DECLARE v_has_rows         TINYINT(1)      DEFAULT 0;
    DECLARE v_last_season      TINYINT(1)      DEFAULT 0;
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
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        -- 8:SETTLED [codes.SeasonStatus]
        IF v_status <> 8 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF i_target = 1 THEN
            SET v_next_status = (SELECT status FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no + 1);
            IF v_next_status IS NULL THEN
                -- cycle_type 0:NONE [codes.CycleType], status 3:ENDED [codes.RankingStatus]
                SET v_last_season = EXISTS (
                    SELECT 1
                      FROM ranking_definition d
                      JOIN ranking_season s ON s.ranking_id = d.ranking_id AND s.season_no = i_season_no
                     WHERE d.ranking_id = i_ranking_id
                       AND (d.cycle_type = 0 OR d.status = 3 OR (d.end_at IS NOT NULL AND d.end_at <= s.end_at)));
            END IF;
            -- v_next_status가 NULL이면 비교 결과가 NULL이 되어 IF가 거짓으로 빠지므로(검사 통과) COALESCE로 막는다.
            IF NOT (COALESCE(v_next_status, 0) = 8 OR (v_next_status IS NULL AND v_last_season = 1)) THEN
                SELECT 1004 AS RESULT;
                LEAVE proc_block;
            END IF;
        END IF;

        SET v_table = IF(i_target = 1, 'ranking_entry', 'ranking_submit_key');
        SET v_partition = CONCAT('p_r', i_ranking_id, '_s', i_season_no);
        SET v_backup = CONCAT(v_table, '_r', i_ranking_id, '_s', i_season_no);

        IF NOT EXISTS (SELECT 1 FROM information_schema.PARTITIONS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = v_table AND PARTITION_NAME = v_partition) THEN
            SELECT 0 AS RESULT;
            SELECT 0 AS exchanged;
            LEAVE proc_block;
        END IF;

        -- 테이블 이름을 변수로 쓸 수 없으므로 대상마다 정적 쿼리를 둔다. (ranking_id, season_no) 조건이 곧 파티션 하나다.
        IF i_target = 1 THEN
            SET v_has_rows = EXISTS (SELECT 1 FROM ranking_entry WHERE ranking_id = i_ranking_id AND season_no = i_season_no);
        ELSE
            SET v_has_rows = EXISTS (SELECT 1 FROM ranking_submit_key WHERE ranking_id = i_ranking_id AND season_no = i_season_no);
        END IF;
        IF v_has_rows = 0 THEN
            SELECT 0 AS RESULT;
            SELECT 0 AS exchanged;
            LEAVE proc_block;
        END IF;

        CALL SP_EXEC_DDL(CONCAT('CREATE TABLE IF NOT EXISTS `', v_backup, '` LIKE `', v_table, '`'));
        -- 파티션 없는 테이블은 PARTITION_NAME이 NULL인 행 하나로 나온다.
        IF EXISTS (SELECT 1 FROM information_schema.PARTITIONS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = v_backup AND PARTITION_NAME IS NOT NULL) THEN
            CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `', v_backup, '` REMOVE PARTITIONING'));
        END IF;
        CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `', v_table, '` EXCHANGE PARTITION `', v_partition, '` WITH TABLE `', v_backup, '`'));

        SELECT 0 AS RESULT;
        SELECT 1 AS exchanged;
    END proc_block;
END$$
DELIMITER ;
