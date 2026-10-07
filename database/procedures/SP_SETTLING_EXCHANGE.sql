DROP PROCEDURE IF EXISTS `SP_SETTLING_EXCHANGE`;
DELIMITER $$
CREATE PROCEDURE `SP_SETTLING_EXCHANGE` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED     -- 시즌 번호 (1 이상, 상태가 SETTLING이어야 함)
) COMMENT 'SETTLING 작업 테이블 단계를 관측해 진행: entry 파티션 꺼내기와 정렬 인덱스 추가, 또는 인덱스 제거 후 되돌리기 (멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_SETTLING_EXCHANGE
    -- 작성 : 2026.10.04 trisakion
    -- 수정 : 2026.10.07 trisakion 정렬 인덱스의 동점 키를 time_unit 시간 슬롯으로 변경 (Redis 순서와 일치)
    -- 내용 : SETTLING의 DDL 단계(01_DESIGN 7.3의 1·2·4·5단계)를 실제 상태를 보고 다음 단계만 실행한다 (8.6, D-49).
    --        가순위 UPDATE(3단계)는 데이터 경로 SP가 하며, 이 SP는 그 앞뒤를 맡는다. 잡은 결과 상태를 보고
    --        1(OUT)이면 가순위 UPDATE를 이어서 하고 다시 호출, 2(RETURNED)면 다음 단계(Redis 키 삭제, REVIEW)로 간다.
    --
    --        관측                                                  동작                                     반환 상태
    --        settling 비어 있음, entry 파티션에 final_rank NULL 있음  꺼내기(EXCHANGE) → 정렬 인덱스 추가         1 OUT
    --        settling 비어 있음, NULL 없음(0명 포함)                  없음 (이미 되돌림)                         2 RETURNED
    --        settling에 이 시즌, final_rank NULL 있음                정렬 인덱스 없으면 추가                     1 OUT
    --        settling에 이 시즌, NULL 없음                           정렬 인덱스 제거 → 되돌리기                 2 RETURNED
    --        settling에 다른 시즌                                    없음 → 1007 (사람이 확인할 상황)
    --
    --        - 상태가 SETTLING일 때만 동작한다. FINALIZING 이후에는 제재 제외 행의 final_rank가 NULL이라 판단이 틀어진다 (8.6).
    --        - 꺼내기는 settling이 비어 있으므로 기본 검증(일반 테이블 행 검사)의 비용이 없다.
    --        - 되돌리기는 WITHOUT VALIDATION이다. 수백만 행 검증 동안 운영 테이블 DDL이 길어지는 것을 피한다 (7.3).
    --          대신 settling의 PK 양 끝 두 행으로 다른 시즌 행이 없음을 확인한다. PK가 (ranking_id, season_no, ...)로
    --          시작하므로 양 끝이 모두 이 시즌이면 전체가 이 시즌이다. 인덱스 끝 두 번 읽기라 행 수와 무관하다.
    --        - 되돌리기 전에 entry 파티션이 비어 있는지 확인한다. 꺼낸 뒤 늦은 쓰기가 들어갔다면(시각 검사 결함 등)
    --          교환이 그 행들을 settling으로 보내 섞이므로, 교환하지 않고 1008로 멈춰 알린다.
    --        - 정렬 인덱스는 랭킹의 정렬 방향(Redis 순서, 7.3)과 같게 만든다. 앞에 (ranking_id, season_no)를 둔다.
    --          동점 키는 achieved_at이 아니라 Redis composite와 같은 시간 슬롯 FLOOR((achieved_at - 시즌 시작) / time_unit)이다.
    --          ms 그대로 비교하면 SEC 이상 랭킹에서 같은 슬롯의 동점자 순서가 Redis(member_id 순)와 달라진다.
    --          시즌 시작 시각을 상수로 넣은 함수 키라 시즌마다 식이 다르며, 가순위 UPDATE의 ORDER BY는 이 식과 똑같아야
    --          인덱스를 탄다. 함수 키의 숨은 컬럼은 인덱스 제거 때 함께 사라지므로 EXCHANGE 구조 일치에 영향이 없다.
    --          가순위 UPDATE는 시즌 조건을 걸므로, 접두가 없으면 옵티마이저가 PK 범위 + filesort를 고를 수 있다.
    --        - 정렬 인덱스는 운영 테이블에 두지 않는다. 되돌리기 전에 제거해야 EXCHANGE의 구조 일치 조건을 만족한다.
    --        - 모든 DDL은 SP_EXEC_DDL을 거친다. 고정 문자열이라 PREPARE가 필요 없는 인덱스 DDL도 감사 로그와
    --          lock_wait_timeout을 한곳에서 적용하기 위해 같은 경로로 실행한다.
    --        - 단계마다 상태가 DB에 남으므로 어느 지점에서 끊겨도 다시 호출하면 이어서 진행한다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_sort_order       TINYINT UNSIGNED;
    DECLARE v_time_unit        TINYINT UNSIGNED;
    DECLARE v_season_start     DATETIME(3);
    DECLARE v_unit_us          BIGINT UNSIGNED;
    DECLARE v_slot             VARCHAR(200);
    DECLARE v_partition        VARCHAR(64);
    DECLARE v_first_rid        INT UNSIGNED;
    DECLARE v_first_sno        INT UNSIGNED;
    DECLARE v_last_rid         INT UNSIGNED;
    DECLARE v_last_sno         INT UNSIGNED;
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

        SELECT s.status, d.sort_order, d.time_unit, s.start_at
          INTO v_status, v_sort_order, v_time_unit, v_season_start
          FROM ranking_season s
          JOIN ranking_definition d ON d.ranking_id = s.ranking_id
         WHERE s.ranking_id = i_ranking_id AND s.season_no = i_season_no;
        IF v_status IS NULL THEN
            SELECT 1002 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF v_status <> 4 THEN
            SELECT 1003 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_partition = CONCAT('p_r', i_ranking_id, '_s', i_season_no);
        IF NOT EXISTS (SELECT 1 FROM information_schema.PARTITIONS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry' AND PARTITION_NAME = v_partition) THEN
            SELECT 1005 AS RESULT;
            LEAVE proc_block;
        END IF;

        -- settling 점유 확인: PK 양 끝 행 (행이 없으면 변수는 NULL 그대로)
        SELECT ranking_id, season_no INTO v_first_rid, v_first_sno
          FROM ranking_entry_settling ORDER BY ranking_id, season_no LIMIT 1;
        SELECT ranking_id, season_no INTO v_last_rid, v_last_sno
          FROM ranking_entry_settling ORDER BY ranking_id DESC, season_no DESC LIMIT 1;
        IF v_first_rid IS NOT NULL
           AND NOT (v_first_rid = i_ranking_id AND v_first_sno = i_season_no AND v_last_rid = i_ranking_id AND v_last_sno = i_season_no) THEN
            SELECT 1007 AS RESULT;
            LEAVE proc_block;
        END IF;

        IF v_first_rid IS NULL THEN
            -- settling이 비어 있다: 아직 꺼내지 않았거나, 이미 되돌렸거나, 참가자가 없다.
            IF NOT EXISTS (SELECT 1 FROM ranking_entry
                            WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank IS NULL) THEN
                SELECT 0 AS RESULT;
                SELECT 2 AS settling_state;
                LEAVE proc_block;
            END IF;
            -- 빈 settling에 정렬 인덱스가 남아 있으면(수동 개입 등) 구조가 달라 EXCHANGE가 1736으로 실패한다. 먼저 걷어낸다.
            IF EXISTS (SELECT 1 FROM information_schema.STATISTICS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND INDEX_NAME = 'ix_settle_order') THEN
                CALL SP_EXEC_DDL('ALTER TABLE `ranking_entry_settling` DROP INDEX `ix_settle_order`');
            END IF;
            CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `ranking_entry` EXCHANGE PARTITION `', v_partition, '` WITH TABLE `ranking_entry_settling`'));
        END IF;

        -- 여기부터 settling에는 이 시즌 행만 있다.
        IF EXISTS (SELECT 1 FROM ranking_entry_settling
                    WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND final_rank IS NULL) THEN
            IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
                            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND INDEX_NAME = 'ix_settle_order') THEN
                -- time_unit 1:MS, 2:SEC, 3:MIN, 4:DAY [codes.TimeUnit] → 마이크로초. 시간 슬롯 식은 rankings.ts composite와 같다.
                SET v_unit_us = CASE v_time_unit
                                    WHEN 1 THEN 1000
                                    WHEN 2 THEN 1000000
                                    WHEN 3 THEN 60000000
                                    WHEN 4 THEN 86400000000
                                END;
                IF v_unit_us IS NULL THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SP_SETTLING_EXCHANGE: unsupported time_unit';
                END IF;
                SET v_slot = CONCAT('(FLOOR(TIMESTAMPDIFF(MICROSECOND, TIMESTAMP''', DATE_FORMAT(v_season_start, '%Y-%m-%d %H:%i:%s.%f'),
                                    ''', `achieved_at`) / ', v_unit_us, '))');
                -- 정렬 방향 2:ASC [codes.SortOrder]. 그 외는 DESC (Redis 순서와 같게, 7.3)
                IF v_sort_order = 2 THEN
                    CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `ranking_entry_settling` ADD INDEX `ix_settle_order` (`ranking_id`, `season_no`, `score` ASC, ', v_slot, ' ASC, `member_id` ASC)'));
                ELSE
                    CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `ranking_entry_settling` ADD INDEX `ix_settle_order` (`ranking_id`, `season_no`, `score` DESC, ', v_slot, ' ASC, `member_id` DESC)'));
                END IF;
            END IF;
            SELECT 0 AS RESULT;
            SELECT 1 AS settling_state;
            LEAVE proc_block;
        END IF;

        -- 가순위 완료: 되돌리기. 교환은 맞바꾸기라 entry 파티션에 행이 있으면 그 행이 settling으로 간다.
        IF EXISTS (SELECT 1 FROM ranking_entry WHERE ranking_id = i_ranking_id AND season_no = i_season_no) THEN
            SELECT 1008 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.STATISTICS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND INDEX_NAME = 'ix_settle_order') THEN
            CALL SP_EXEC_DDL('ALTER TABLE `ranking_entry_settling` DROP INDEX `ix_settle_order`');
        END IF;
        CALL SP_EXEC_DDL(CONCAT('ALTER TABLE `ranking_entry` EXCHANGE PARTITION `', v_partition, '` WITH TABLE `ranking_entry_settling` WITHOUT VALIDATION'));

        SELECT 0 AS RESULT;
        SELECT 2 AS settling_state;
    END proc_block;
END$$
DELIMITER ;
