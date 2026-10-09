DROP PROCEDURE IF EXISTS `SP_SUBMIT_SCORE`;
DELIMITER $$
CREATE PROCEDURE `SP_SUBMIT_SCORE` (
    IN i_ranking_id     INT UNSIGNED,                                    -- 랭킹 ID (1 이상)
    IN i_season_no      INT UNSIGNED,                                    -- 게임 서버가 플레이 시작 시점에 받은 시즌 번호 (seasonNo)
    IN i_member_id      VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,  -- 멤버 ID (대소문자 구분)
    IN i_input_value    BIGINT,                                          -- 입력 값 (BEST:이번 기록, SUM:부호 있는 증분)
    IN i_request_id     VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin   -- 멱등 키 (requestId, 대소문자 구분)
) COMMENT '스코어 제출: 랭킹·시즌 시각 검사, 멱등 키, 하드 검증, 갱신 규칙 적용 후 현재 entry 상태 반환'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_SUBMIT_SCORE
    -- 작성 : 2026.10.04 trisakion
    -- 내용 : 01_DESIGN 2.3, 4.1~4.4, 9.1. 데이터 경로 SP라 정적 SQL만 쓴다.
    --        RESULT: 0 성공(재전송 포함), 1001 파라미터, 1101 랭킹 없음, 1102 비 ACTIVE(D-34), 1103 SEASON_MISMATCH,
    --                1104 IDEMPOTENCY_CONFLICT(D-33), 1105 SCORE_RANGE, 1106 MAX_DELTA, 1107 SCORE_MAX [codes.SpResult]
    --        성공 데이터: season_no, season_start_at(composite 계산용), score, achieved_at, version, replayed
    --
    --        - 쓰기 차단은 상태가 아니라 시각으로 한다(3.5). 시즌 행의 [start_at, end_at)에 NOW(3)가 들어야 한다.
    --          검사와 쓰기 사이에 end_at을 지나칠 수 있지만, 기록되는 achieved_at은 검사에 쓴 같은 v_now라 시즌 안이다.
    --          그 차이(수 ms)는 리컨실러 안전마진과 정산 지연(settle_delay)이 흡수한다.
    --        - 랭킹·시즌 검사 실패는 멱등 키 없이 결과만 반환한다(4.1). 그래서 트랜잭션 전에 끝낸다.
    --        - 멱등 키를 entry보다 먼저 INSERT한다(TABLE_LOCK_ORDER: submit_key → entry). 같은 requestId의 동시 요청은
    --          키 충돌(1062)에서 줄을 서고, 늦은 쪽은 먼저 커밋된 키를 읽어 재전송/충돌로 판정한다. 먼저 조회한 뒤
    --          INSERT하는 방식은 두 요청이 모두 "없음"을 보고 둘 다 반영하는 틈이 생긴다.
    --        - 재전송은 반영하지 않고 현재 entry 상태를 돌려준다(4.4). 이전에 거부된 키면 같은 거부를 돌려준다.
    --        - 하드 검증 중 입력만으로 판정되는 것(범위, max_delta)은 키를 rejected와 함께 바로 기록한다.
    --          SUM 결과의 score_max 초과는 현재 점수가 필요하므로 entry를 잠근 뒤 판정하고 키에 사유를 갱신한다.
    --        - BEST: 4.3의 ODKU. score를 마지막에 갱신하고, 더 좋은 기록일 때만 achieved_at·version·updated_at을 바꾼다.
    --        - SUM: entry 존재를 잠그지 않고(일관된 읽기) 먼저 본다. 없는 행을 FOR UPDATE로 찾으면 REPEATABLE READ에서
    --          갭 락이 걸리고, 같은 멤버의 첫 제출이 동시에 오면 서로의 INSERT를 막아 데드락이 나기 때문이다.
    --            행 없음, 증분 ≤ 0 : 행을 만들지 않는다(D-32). 0점에서 시작하는 음수 증분은 결과가 0이라 동시에 들어온
    --                                 양수 첫 제출과 어떤 순서로 직렬화해도 결과가 같다.
    --            행 없음, 증분 > 0 : INSERT. 그 사이 다른 요청이 먼저 만들었으면(1062) 롤백하고 처음부터 한 번 다시 한다(txn 루프).
    --            행 있음           : 행을 FOR UPDATE로 잠그고(레코드 락만 걸린다) 새 값을 계산해 바뀔 때만 UPDATE한다.
    --          부호 있는 증분과 UNSIGNED score의 합은 음수·범위 초과가 날 수 있어 DECIMAL로 계산한다.
    --        - 값이 그대로면 version, achieved_at, updated_at을 건드리지 않는다(2.3). 리컨실러 스캔 대상도 늘지 않는다.
    --        - 응답 값은 커밋 전에 FOR SHARE로 읽는다. 일관된 읽기는 트랜잭션 스냅샷이라 그 뒤 커밋된 더 새 version을
    --          놓칠 수 있다. 커밋 뒤에 읽으면 RESULT 0을 보낸 다음 읽기가 실패할 때 결과셋이 어긋난다.
    --          행이 없으면 score 0, version 0, achieved_at NULL이다(D-32). 앱은 version 0이면 Redis 반영을 건너뛴다.
    --        - 시즌 파티션이 없으면(시즌 행만 있고 SP_PARTITION_ADD 전) INSERT가 실패해 50001이 된다. 다른 파티션으로
    --          조용히 들어가지 않는다(4.2).
    --        - 락 대기는 문장마다 5초로 줄인다(innodb_lock_wait_timeout, 기본 50초). updated_at은 SP 시작 시각인데
    --          커밋이 리컨실러 안전마진(60초)보다 늦으면 변경분 스캔이 그 행을 지나쳐 Redis 반영이 실패했을 때 영영 빠진다.
    --          잠그는 문장은 많아야 4개, txn 루프 재시도까지 8개라 40초 안에 끝나거나 1205로 실패한다(50001,
    --          같은 requestId로 재시도). 세션 변수라 풀 커넥션의 다른 SP에 남지 않게 끝에서 되돌린다.
    -- 수정 : 2026.10.09 trisakion 락 대기 5초 제한 (리컨실러 안전마진 보장)
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)        DEFAULT NOW(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_update_rule      TINYINT UNSIGNED;
    DECLARE v_sort_order       TINYINT UNSIGNED;
    DECLARE v_score_max        BIGINT UNSIGNED;
    DECLARE v_max_delta        BIGINT UNSIGNED;
    DECLARE v_season_start     DATETIME(3);
    DECLARE v_season_end       DATETIME(3);
    DECLARE v_rejected         VARCHAR(32);
    DECLARE v_key_dup          TINYINT(1)         DEFAULT 0;
    DECLARE v_key_member       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
    DECLARE v_key_input        BIGINT;
    DECLARE v_key_rejected     VARCHAR(32);
    DECLARE v_entry_exists     TINYINT(1)         DEFAULT 0;
    DECLARE v_entry_dup        TINYINT(1)         DEFAULT 0;
    DECLARE v_cur              BIGINT UNSIGNED;
    DECLARE v_new              DECIMAL(21, 0);
    DECLARE v_score            BIGINT UNSIGNED    DEFAULT 0;
    DECLARE v_achieved_at      DATETIME(3)        DEFAULT NULL;
    DECLARE v_version          INT UNSIGNED       DEFAULT 0;
    DECLARE v_replayed         TINYINT(1)         DEFAULT 0;
    DECLARE v_attempt          TINYINT UNSIGNED   DEFAULT 1;
    DECLARE sql_state          CHAR(5)            DEFAULT '00000';
    DECLARE error_no           INT                DEFAULT 0;
    DECLARE error_message      VARCHAR(512)       DEFAULT '';
    DECLARE v_prev_lock_wait   INT UNSIGNED       DEFAULT @@SESSION.innodb_lock_wait_timeout;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        ROLLBACK;
        SET SESSION innodb_lock_wait_timeout = v_prev_lock_wait;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    SET SESSION innodb_lock_wait_timeout = 5;

    proc_block: BEGIN
        -- ---------------------------------------------------------------------------------------------- 검증 (트랜잭션 전)
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0
           OR i_member_id IS NULL OR i_member_id = '' OR i_request_id IS NULL OR i_request_id = ''
           OR i_input_value IS NULL THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT status, update_rule, sort_order, score_max, max_delta
          INTO v_status, v_update_rule, v_sort_order, v_score_max, v_max_delta
          FROM ranking_definition
         WHERE ranking_id = i_ranking_id;
        IF v_status IS NULL THEN
            SELECT 1101 AS RESULT;
            LEAVE proc_block;
        END IF;
        -- 1:ACTIVE [codes.RankingStatus]
        IF v_status <> 1 THEN
            SELECT 1102 AS RESULT;
            LEAVE proc_block;
        END IF;
        -- 1:BEST, 2:SUM [codes.UpdateRule]. LATEST는 등록 단계에서 거부되므로 여기 오면 정의 데이터가 잘못된 것이다.
        IF v_update_rule NOT IN (1, 2) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SP_SUBMIT_SCORE: unsupported update_rule';
        END IF;

        SELECT start_at, end_at
          INTO v_season_start, v_season_end
          FROM ranking_season
         WHERE ranking_id = i_ranking_id AND season_no = i_season_no;
        IF v_season_start IS NULL OR v_now < v_season_start OR v_now >= v_season_end THEN
            SELECT 1103 AS RESULT;
            LEAVE proc_block;
        END IF;

        -- 입력만으로 판정되는 하드 검증. 키에 사유와 함께 기록하므로 아직 반환하지 않는다.
        IF v_update_rule = 1 THEN
            IF i_input_value < 0 OR i_input_value > v_score_max THEN
                SET v_rejected = 'SCORE_RANGE';
            END IF;
        ELSE
            -- ABS(BIGINT 최솟값)는 범위 초과 오류가 나므로 DECIMAL로 바꿔 비교한다.
            IF v_max_delta IS NOT NULL AND ABS(CAST(i_input_value AS DECIMAL(20, 0))) > v_max_delta THEN
                SET v_rejected = 'MAX_DELTA';
            END IF;
        END IF;

        -- ---------------------------------------------------------------------------------------------- 처리
        txn: LOOP
            START TRANSACTION;
            SET v_key_dup = 0;
            SET v_entry_dup = 0;
            SET v_replayed = 0;

            insert_key: BEGIN
                DECLARE CONTINUE HANDLER FOR 1062 SET v_key_dup = 1;
                INSERT INTO ranking_submit_key (ranking_id, season_no, request_id, member_id, input_value, rejected, created_at)
                VALUES (i_ranking_id, i_season_no, i_request_id, i_member_id, i_input_value, v_rejected, v_now);
            END insert_key;

            IF v_key_dup = 1 THEN
                -- 1062는 상대가 커밋한 뒤에만 나므로 이 읽기에서 키가 보인다.
                SELECT member_id, input_value, rejected
                  INTO v_key_member, v_key_input, v_key_rejected
                  FROM ranking_submit_key
                 WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND request_id = i_request_id;
                IF v_key_member <> i_member_id OR v_key_input <> i_input_value THEN
                    ROLLBACK;
                    SELECT 1104 AS RESULT;
                    LEAVE proc_block;
                END IF;
                IF v_key_rejected IS NOT NULL THEN
                    ROLLBACK;
                    SELECT CASE v_key_rejected
                               WHEN 'SCORE_RANGE' THEN 1105
                               WHEN 'MAX_DELTA'   THEN 1106
                               ELSE 1107
                           END AS RESULT;
                    LEAVE proc_block;
                END IF;
                SET v_replayed = 1;
            ELSEIF v_rejected IS NOT NULL THEN
                COMMIT;
                SELECT IF(v_rejected = 'SCORE_RANGE', 1105, 1106) AS RESULT;
                LEAVE proc_block;
            ELSEIF v_update_rule = 1 THEN
                -- 4.3. 정렬 방향에 따라 "더 좋은 기록"의 비교가 반대다 (1:DESC, 2:ASC [codes.SortOrder]).
                INSERT INTO ranking_entry (ranking_id, season_no, member_id, score, achieved_at, version, updated_at)
                VALUES (i_ranking_id, i_season_no, i_member_id, i_input_value, v_now, 1, v_now) AS n
                ON DUPLICATE KEY UPDATE
                    achieved_at = IF(IF(v_sort_order = 2, n.score < ranking_entry.score, n.score > ranking_entry.score),
                                     n.achieved_at, ranking_entry.achieved_at),
                    version     = IF(IF(v_sort_order = 2, n.score < ranking_entry.score, n.score > ranking_entry.score),
                                     ranking_entry.version + 1, ranking_entry.version),
                    updated_at  = IF(IF(v_sort_order = 2, n.score < ranking_entry.score, n.score > ranking_entry.score),
                                     n.updated_at, ranking_entry.updated_at),
                    score       = IF(IF(v_sort_order = 2, n.score < ranking_entry.score, n.score > ranking_entry.score),
                                     n.score, ranking_entry.score);   -- 반드시 마지막 (4.3)
            ELSE
                -- SET v = (SELECT ...)로 쓰면 SELECT가 아닌 문장의 서브쿼리라 REPEATABLE READ에서 S 락으로 읽는다.
                -- 없는 행이면 갭에 S 락이 남아, 같은 멤버의 첫 제출끼리 서로의 INSERT를 막는 데드락이 난다(실측).
                -- SELECT ... INTO는 잠그지 않는 일관된 읽기다.
                SELECT EXISTS (SELECT 1 FROM ranking_entry
                                WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id)
                  INTO v_entry_exists;
                IF v_entry_exists = 0 AND i_input_value > 0 THEN
                    -- 기존 행이 없으면 결과는 증분 그대로다.
                    IF i_input_value > v_score_max THEN
                        UPDATE ranking_submit_key SET rejected = 'SCORE_MAX'
                         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND request_id = i_request_id;
                        COMMIT;
                        SELECT 1107 AS RESULT;
                        LEAVE proc_block;
                    END IF;
                    insert_entry: BEGIN
                        DECLARE CONTINUE HANDLER FOR 1062 SET v_entry_dup = 1;
                        INSERT INTO ranking_entry (ranking_id, season_no, member_id, score, achieved_at, version, updated_at)
                        VALUES (i_ranking_id, i_season_no, i_member_id, i_input_value, v_now, 1, v_now);
                    END insert_entry;
                    -- 1062로 끝난 INSERT는 상대 행에 S 락을 남긴다. 그대로 FOR UPDATE(X)로 올리면 같은 처지의 다른 요청과
                    -- 서로의 S 락을 기다려 데드락이 난다. 롤백으로 S 락을 놓고 처음부터 한 번 다시 한다. 다시 할 때는
                    -- 행이 보이므로 행 있음 경로로 간다. 멱등 키도 함께 롤백되므로 다시 기록한다.
                    IF v_entry_dup = 1 AND v_attempt = 1 THEN
                        ROLLBACK;
                        SET v_attempt = 2;
                        ITERATE txn;
                    END IF;
                END IF;

                IF v_entry_exists = 1 OR v_entry_dup = 1 THEN
                    SELECT score INTO v_cur
                      FROM ranking_entry
                     WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id
                       FOR UPDATE;
                    -- 운영 중 entry 행은 지워지지 않는다. 사라졌다면 시즌 진행 중 파티션이 교환된 것이므로 중단한다.
                    IF v_cur IS NULL THEN
                        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SP_SUBMIT_SCORE: entry row vanished';
                    END IF;
                    SET v_new = GREATEST(CAST(v_cur AS DECIMAL(21, 0)) + i_input_value, 0);
                    IF v_new > v_score_max THEN
                        UPDATE ranking_submit_key SET rejected = 'SCORE_MAX'
                         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND request_id = i_request_id;
                        COMMIT;
                        SELECT 1107 AS RESULT;
                        LEAVE proc_block;
                    END IF;
                    IF v_new <> v_cur THEN
                        UPDATE ranking_entry
                           SET achieved_at = v_now,
                               version     = version + 1,
                               updated_at  = v_now,
                               score       = v_new
                         WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id;
                    END IF;
                END IF;
            END IF;

            -- 행이 없으면 대입되지 않아 기본값(0, NULL, 0)이 남는다 (D-32).
            SELECT score, achieved_at, version
              INTO v_score, v_achieved_at, v_version
              FROM ranking_entry
             WHERE ranking_id = i_ranking_id AND season_no = i_season_no AND member_id = i_member_id
               FOR SHARE;
            LEAVE txn;
        END LOOP txn;

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT i_season_no AS season_no, v_season_start AS season_start_at, v_score AS score,
               v_achieved_at AS achieved_at, v_version AS version, v_replayed AS replayed;
    END proc_block;

    -- 모든 LEAVE proc_block이 여기로 온다.
    SET SESSION innodb_lock_wait_timeout = v_prev_lock_wait;
END$$
DELIMITER ;
