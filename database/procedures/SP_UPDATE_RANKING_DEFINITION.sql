DROP PROCEDURE IF EXISTS `SP_UPDATE_RANKING_DEFINITION`;
DELIMITER $$
CREATE PROCEDURE `SP_UPDATE_RANKING_DEFINITION` (
    IN i_requester_id          INT UNSIGNED,        -- 요청자 GM 계정 ID
    IN i_ranking_id            INT UNSIGNED,        -- 랭킹 ID
    IN i_ranking_name          VARCHAR(128),        -- 랭킹 이름
    IN i_status                TINYINT UNSIGNED,    -- 상태 (1:ACTIVE, 2:PAUSED, 3:ENDED) [codes.RankingStatus]
    IN i_timezone              VARCHAR(64),         -- 시즌 경계 시간대 (IANA)
    IN i_start_at              DATETIME(3),         -- 랭킹 시작 시각 (UTC)
    IN i_end_at                DATETIME(3),         -- 랭킹 종료 시각 (UTC, NULL:없음)
    IN i_cycle_type            TINYINT UNSIGNED,    -- 시즌 주기 (0:NONE, 1:DAILY, 2:WEEKLY, 3:MONTHLY, 4:FIXED) [codes.CycleType]
    IN i_cycle_value           INT UNSIGNED,        -- FIXED 길이(초, 그 외 NULL)
    IN i_wait_period           INT UNSIGNED,        -- 시즌 사이 대기(초)
    IN i_settle_delay          INT UNSIGNED,        -- 시즌 종료 → 정산 시작 유예(초)
    IN i_review_period         INT UNSIGNED,        -- 검수 기간(초)
    IN i_top_size              SMALLINT UNSIGNED,   -- 시즌별 영구 보관 상위 인원
    IN i_history_retention     INT UNSIGNED,        -- 시즌 백업 보관 일수 (0:무기한)
    IN i_max_delta             BIGINT UNSIGNED,     -- SUM 1회 최대 증분 (NULL:제한 없음)
    IN i_max_submit_per_min    INT UNSIGNED,        -- 멤버별 분당 최대 제출 수 (NULL:제한 없음)
    IN i_suspicion_config      JSON,                -- 어뷰징 탐지 규칙 (NULL:끔)
    IN i_extend_season_no      INT UNSIGNED,        -- 늘리기: 옛 end_at에서 잘려 있던 마지막 시즌 번호 (NULL:없음)
    IN i_extend_end_at         DATETIME(3)          -- 늘리기: 그 시즌의 새 종료 시각 (앱이 새 정의로 계산)
) COMMENT '랭킹 정의 수정 (operator, D-79 묶음 규칙, 시즌 일정·종료 변경 반영)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPDATE_RANKING_DEFINITION
    -- 작성 : 2026.10.23 trisakion
    -- 내용 : PATCH /admin/v1/rankings/{id} (01_DESIGN 2.8, 10.4, D-79, D-81).
    --        RESULT: 0 성공, 1001 파라미터, 1405 권한 부족, 1501 랭킹 없음, 1503 지금 상태에서 바꿀 수 없음 [codes.SpResult]
    --        성공 데이터: deleted_seasons(지운 시즌 번호, 쉼표 구분, 없으면 NULL) 1행 — 앱이 커밋 뒤 빈 파티션을 지운다.
    --
    --        - 앱이 수정 전 값과 요청을 합쳐 바뀔 수 있는 컬럼 전체를 넘긴다. 순위 규칙(update_rule 등)은 받지 않는다(불변).
    --          등록 검증(2.7)은 앱이 한다. 시즌 경계 계산에 시간대가 필요해서다.
    --        - 앱은 스케줄러 락(podium:schedule)을 잡고 부른다. 앱이 읽은 시즌으로 계산한 늘리기 값이 그대로 맞는다.
    --          SP는 락과 별개로 정의 행을 잠그고 상태 조건을 다시 본다(개발 컨벤션 6.1 상태전이).
    --        - 거부(1503): ENDED에서 상태·일정·종료 변경, 시즌이 하나라도 시작한 뒤 일정 변경,
    --          지금 end_at이 이미 지났는데 종료 변경(끝난 랭킹 늘리기), 새 end_at이 지난 시각.
    --        - 시즌 반영:
    --          · 일정 변경: 시즌을 모두 지운다(모두 SCHEDULED임을 위에서 확인). 스케줄러가 새 정의로 다시 만든다.
    --          · 늘리기: 옛 end_at에서 잘려 있던 시즌의 종료와 settle_at을 앱이 계산한 값으로 늘린다.
    --          · 줄이기: 새 end_at 이후 시작하는 SCHEDULED 시즌을 지우고, 새 end_at에 걸친 시즌(SCHEDULED·OPEN)을
    --            그 시각에 끝나게 한다(OPEN이면 조기 종료). settle_at은 새 settle_delay로 다시 계산한다.
    --          · ENDED 전이: 아직 시작하지 않은 SCHEDULED 시즌을 지운다. 진행 중 시즌은 원래 종료까지 간다.
    --        - 조기 종료로 end_at이 당겨져도 정산의 미종료 트랜잭션 대기(7.1)는 end_at 기준이라 그대로 맞다 —
    --          새 end_at ≥ 지금이므로 이 커밋 전에 시작한 제출 트랜잭션은 모두 새 end_at 전에 시작했다.
    --        - 잠금 순서: ranking_definition → ranking_season (TABLE_LOCK_ORDER 1, 3).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)         DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_status           TINYINT UNSIGNED;
    DECLARE v_timezone         VARCHAR(64);
    DECLARE v_start_at         DATETIME(3);
    DECLARE v_end_at           DATETIME(3);
    DECLARE v_cycle_type       TINYINT UNSIGNED;
    DECLARE v_cycle_value      INT UNSIGNED;
    DECLARE v_wait_period      INT UNSIGNED;
    DECLARE v_schedule         TINYINT             DEFAULT 0;
    DECLARE v_end_changed      TINYINT             DEFAULT 0;
    DECLARE v_started          TINYINT             DEFAULT 0;
    DECLARE v_part             VARCHAR(1024);
    DECLARE v_deleted          VARCHAR(1024)       DEFAULT NULL;
    DECLARE sql_state          CHAR(5)             DEFAULT '00000';
    DECLARE error_no           INT                 DEFAULT 0;
    DECLARE error_message      VARCHAR(512)        DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        ROLLBACK;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    proc_block: BEGIN
        IF i_requester_id IS NULL OR i_requester_id = 0 OR i_ranking_id IS NULL OR i_ranking_id = 0
           OR i_ranking_name IS NULL OR TRIM(i_ranking_name) = ''
           OR i_status IS NULL OR i_status NOT IN (1, 2, 3)
           OR i_timezone IS NULL OR i_timezone = '' OR i_start_at IS NULL
           OR (i_end_at IS NOT NULL AND i_end_at <= i_start_at)
           OR i_cycle_type IS NULL OR i_cycle_type NOT IN (0, 1, 2, 3, 4)
           OR (i_cycle_type = 4 AND (i_cycle_value IS NULL OR i_cycle_value = 0))
           OR (i_cycle_type <> 4 AND i_cycle_value IS NOT NULL)
           OR i_wait_period IS NULL OR i_settle_delay IS NULL OR i_review_period IS NULL
           OR i_top_size IS NULL OR i_history_retention IS NULL
           OR (i_extend_season_no IS NULL) <> (i_extend_end_at IS NULL) THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 2 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        START TRANSACTION;

        SELECT status, timezone, start_at, end_at, cycle_type, cycle_value, wait_period
          INTO v_status, v_timezone, v_start_at, v_end_at, v_cycle_type, v_cycle_value, v_wait_period
          FROM ranking_definition
         WHERE ranking_id = i_ranking_id
           FOR UPDATE;
        IF v_status IS NULL THEN
            ROLLBACK;
            SELECT 1501 AS RESULT;
            LEAVE proc_block;
        END IF;

        SET v_schedule = NOT (i_timezone <=> v_timezone AND i_start_at <=> v_start_at AND i_cycle_type <=> v_cycle_type
                              AND i_cycle_value <=> v_cycle_value AND i_wait_period <=> v_wait_period);
        SET v_end_changed = NOT (i_end_at <=> v_end_at);

        -- 3:ENDED는 되돌리지 않는다. 남은 시즌 정산에 쓰이는 운영 값·단계 값만 바꿀 수 있다.
        IF v_status = 3 AND (i_status <> 3 OR v_schedule = 1 OR v_end_changed = 1) THEN
            ROLLBACK;
            SELECT 1503 AS RESULT;
            LEAVE proc_block;
        END IF;

        IF v_schedule = 1 THEN
            -- 1:SCHEDULED가 아닌 시즌이나 시작 시각이 지난 시즌이 있으면 게임 서버가 이미 시즌 번호를 쓰고 있다.
            SELECT EXISTS (SELECT 1 FROM ranking_season
                            WHERE ranking_id = i_ranking_id AND (status <> 1 OR start_at <= v_now)) INTO v_started;
            IF v_started = 1 OR v_start_at <= v_now OR i_start_at <= v_now THEN
                ROLLBACK;
                SELECT 1503 AS RESULT;
                LEAVE proc_block;
            END IF;
        END IF;

        -- 끝난 랭킹을 늘리면 다음 시즌이 달력 경계가 아니라 옛 종료 시각에서 시작한다. 지난 시각으로 줄일 수도 없다.
        IF v_end_changed = 1 AND ((v_end_at IS NOT NULL AND v_end_at <= v_now) OR (i_end_at IS NOT NULL AND i_end_at <= v_now)) THEN
            ROLLBACK;
            SELECT 1503 AS RESULT;
            LEAVE proc_block;
        END IF;

        UPDATE ranking_definition
           SET ranking_name = i_ranking_name, status = i_status, timezone = i_timezone, start_at = i_start_at, end_at = i_end_at,
               cycle_type = i_cycle_type, cycle_value = i_cycle_value, wait_period = i_wait_period,
               settle_delay = i_settle_delay, review_period = i_review_period, top_size = i_top_size,
               history_retention = i_history_retention, max_delta = i_max_delta, max_submit_per_min = i_max_submit_per_min,
               suspicion_config = i_suspicion_config, updated_at = v_now
         WHERE ranking_id = i_ranking_id;

        IF v_schedule = 1 THEN
            SELECT GROUP_CONCAT(season_no ORDER BY season_no) INTO v_part
              FROM ranking_season WHERE ranking_id = i_ranking_id FOR UPDATE;
            SET v_deleted = v_part;
            DELETE FROM ranking_season WHERE ranking_id = i_ranking_id;
        ELSE
            IF i_extend_season_no IS NOT NULL THEN
                -- 잘려 있던 시즌만(end_at = 옛 랭킹 end_at) 늘린다. 아직 끝나지 않은 시즌(1:SCHEDULED, 2:OPEN)만 대상이다.
                UPDATE ranking_season
                   SET end_at = i_extend_end_at, settle_at = i_extend_end_at + INTERVAL i_settle_delay SECOND
                 WHERE ranking_id = i_ranking_id AND season_no = i_extend_season_no
                   AND end_at = v_end_at AND status <= 2 AND end_at < i_extend_end_at;
            END IF;
            IF v_end_changed = 1 AND i_end_at IS NOT NULL THEN
                SET v_part = NULL;
                SELECT GROUP_CONCAT(season_no ORDER BY season_no) INTO v_part
                  FROM ranking_season
                 WHERE ranking_id = i_ranking_id AND start_at >= i_end_at AND status = 1
                   FOR UPDATE;
                SET v_deleted = v_part;
                DELETE FROM ranking_season WHERE ranking_id = i_ranking_id AND start_at >= i_end_at AND status = 1;
                UPDATE ranking_season
                   SET end_at = i_end_at, settle_at = i_end_at + INTERVAL i_settle_delay SECOND
                 WHERE ranking_id = i_ranking_id AND start_at < i_end_at AND end_at > i_end_at AND status <= 2;
            END IF;
            IF i_status = 3 AND v_status <> 3 THEN
                SET v_part = NULL;
                SELECT GROUP_CONCAT(season_no ORDER BY season_no) INTO v_part
                  FROM ranking_season
                 WHERE ranking_id = i_ranking_id AND status = 1 AND start_at > v_now
                   FOR UPDATE;
                SET v_deleted = CONCAT_WS(',', v_deleted, v_part);
                DELETE FROM ranking_season WHERE ranking_id = i_ranking_id AND status = 1 AND start_at > v_now;
            END IF;
        END IF;

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT NULLIF(v_deleted, '') AS deleted_seasons;
    END proc_block;
END$$
DELIMITER ;
