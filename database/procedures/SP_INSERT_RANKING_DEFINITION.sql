DROP PROCEDURE IF EXISTS `SP_INSERT_RANKING_DEFINITION`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_RANKING_DEFINITION` (
    IN i_requester_id          INT UNSIGNED,        -- 요청자 GM 계정 ID
    IN i_ranking_code          VARCHAR(64),         -- 랭킹 코드 (대소문자 구분)
    IN i_ranking_name          VARCHAR(128),        -- 랭킹 이름
    IN i_status                TINYINT UNSIGNED,    -- 처음 상태 (1:ACTIVE, 2:PAUSED) [codes.RankingStatus]
    IN i_update_rule           TINYINT UNSIGNED,    -- 갱신 규칙 (1:BEST, 2:SUM) [codes.UpdateRule]
    IN i_sort_order            TINYINT UNSIGNED,    -- 정렬 방향 (1:DESC, 2:ASC) [codes.SortOrder]
    IN i_score_max             BIGINT UNSIGNED,     -- 스코어 상한 (1 이상)
    IN i_time_unit             TINYINT UNSIGNED,    -- 동점 처리 시간 단위 (1:MS, 2:SEC, 3:MIN, 4:DAY) [codes.TimeUnit]
    IN i_time_bits             TINYINT UNSIGNED,    -- composite 시간 비트 수 (앱이 53 − bits(score_max)로 계산)
    IN i_timezone              VARCHAR(64),         -- 시즌 경계 시간대 (IANA)
    IN i_start_at              DATETIME(3),         -- 랭킹 시작 시각 (UTC)
    IN i_end_at                DATETIME(3),         -- 랭킹 종료 시각 (UTC, NULL:없음)
    IN i_cycle_type            TINYINT UNSIGNED,    -- 시즌 주기 (0:NONE, 1:DAILY, 2:WEEKLY, 3:MONTHLY, 4:FIXED) [codes.CycleType]
    IN i_cycle_value           INT UNSIGNED,        -- FIXED 길이(초, 그 외 NULL)
    IN i_settle_delay          INT UNSIGNED,        -- 시즌 종료 → 정산 시작 유예(초)
    IN i_wait_period           INT UNSIGNED,        -- 시즌 사이 대기(초)
    IN i_review_period         INT UNSIGNED,        -- 검수 기간(초)
    IN i_top_size              SMALLINT UNSIGNED,   -- 시즌별 영구 보관 상위 인원
    IN i_history_retention     INT UNSIGNED,        -- 시즌 백업 보관 일수 (0:무기한)
    IN i_max_delta             BIGINT UNSIGNED,     -- SUM 1회 최대 증분 (NULL:제한 없음)
    IN i_max_submit_per_min    INT UNSIGNED,        -- 멤버별 분당 최대 제출 수 (NULL:제한 없음)
    IN i_suspicion_config      JSON,                -- 어뷰징 탐지 규칙 (NULL:끔, 01_DESIGN 9.3)
    IN i_tiers                 JSON                 -- 보상 구간 배열 [{tierNo, rangeType, rangeFrom, rangeTo, rewardCode}]
) COMMENT '랭킹 정의와 보상 구간 등록 (operator, 시즌은 스케줄러가 만듦)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_RANKING_DEFINITION
    -- 작성 : 2026.10.23 trisakion
    -- 내용 : POST /admin/v1/rankings (01_DESIGN 2.7, 10.4, D-81).
    --        RESULT: 0 성공, 1001 파라미터, 1405 권한 부족, 1502 ranking_code 중복 [codes.SpResult]
    --        성공 데이터: ranking_id 1행
    --        - 등록 검증(비트 예산, 일정, 정산 기간, 보상 구간)은 앱이 한다. 시즌 경계 계산에 시간대가 필요해서다.
    --          SP는 코드 값 범위와 필수 값만 다시 본다.
    --        - 요청자 역할을 FN_GET_ADMIN_ROLE로 다시 본다(OPERATOR 이상).
    --        - 시즌은 만들지 않는다. 스케줄러가 다음 주기에 시즌 1과 파티션을 만든다(3.3, D-81).
    --        - 중복은 uk_ranking_code 위반(1062)으로 판단한다. 조회 후 INSERT는 동시 등록 사이에 틈이 있다.
    --          보상 구간의 PK(1062)는 앱이 tier_no 중복을 막으므로 1502로 섞이지 않게 정의 INSERT에만 핸들러를 둔다.
    --        - 정의 → 보상 구간 순으로 한 트랜잭션이다 (TABLE_LOCK_ORDER 1, 2).
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)         DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_duplicate        TINYINT             DEFAULT 0;
    DECLARE v_id               INT UNSIGNED;
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
        IF i_requester_id IS NULL OR i_requester_id = 0
           OR i_ranking_code IS NULL OR i_ranking_code = '' OR i_ranking_name IS NULL OR TRIM(i_ranking_name) = ''
           OR i_status IS NULL OR i_status NOT IN (1, 2)
           OR i_update_rule IS NULL OR i_update_rule NOT IN (1, 2)
           OR i_sort_order IS NULL OR i_sort_order NOT IN (1, 2)
           OR i_score_max IS NULL OR i_score_max = 0
           OR i_time_unit IS NULL OR i_time_unit NOT IN (1, 2, 3, 4)
           OR i_time_bits IS NULL OR i_time_bits = 0 OR i_time_bits > 52
           OR i_timezone IS NULL OR i_timezone = '' OR i_start_at IS NULL
           OR (i_end_at IS NOT NULL AND i_end_at <= i_start_at)
           OR i_cycle_type IS NULL OR i_cycle_type NOT IN (0, 1, 2, 3, 4)
           OR (i_cycle_type = 4 AND (i_cycle_value IS NULL OR i_cycle_value = 0))
           OR (i_cycle_type <> 4 AND i_cycle_value IS NOT NULL)
           OR i_settle_delay IS NULL OR i_wait_period IS NULL OR i_review_period IS NULL
           OR i_top_size IS NULL OR i_history_retention IS NULL
           OR i_tiers IS NULL OR JSON_TYPE(i_tiers) <> 'ARRAY' THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;
        IF FN_GET_ADMIN_ROLE(i_requester_id) < 2 THEN
            SELECT 1405 AS RESULT;
            LEAVE proc_block;
        END IF;

        START TRANSACTION;

        BEGIN
            -- 1062(중복 키)만 따로 받는다. 더 구체적인 핸들러가 SQLEXCEPTION 핸들러보다 먼저 선택된다.
            DECLARE CONTINUE HANDLER FOR 1062 SET v_duplicate = 1;
            INSERT INTO ranking_definition
                (ranking_code, ranking_name, status, update_rule, sort_order, score_max, time_unit, time_bits,
                 timezone, start_at, end_at, cycle_type, cycle_value, settle_delay, wait_period, review_period,
                 top_size, history_retention, max_delta, max_submit_per_min, suspicion_config, created_at, updated_at)
            VALUES
                (i_ranking_code, i_ranking_name, i_status, i_update_rule, i_sort_order, i_score_max, i_time_unit, i_time_bits,
                 i_timezone, i_start_at, i_end_at, i_cycle_type, i_cycle_value, i_settle_delay, i_wait_period, i_review_period,
                 i_top_size, i_history_retention, i_max_delta, i_max_submit_per_min, i_suspicion_config, v_now, v_now);
        END;

        IF v_duplicate = 1 THEN
            ROLLBACK;
            SELECT 1502 AS RESULT;
            LEAVE proc_block;
        END IF;
        SET v_id = LAST_INSERT_ID();

        INSERT INTO ranking_reward_tier (ranking_id, tier_no, range_type, range_from, range_to, reward_code)
        SELECT v_id, t.tier_no, t.range_type, t.range_from, t.range_to, t.reward_code
          FROM JSON_TABLE(i_tiers, '$[*]' COLUMNS (
                   tier_no        SMALLINT UNSIGNED    PATH '$.tierNo',
                   range_type     TINYINT UNSIGNED     PATH '$.rangeType',
                   range_from     INT UNSIGNED         PATH '$.rangeFrom',
                   range_to       INT UNSIGNED         PATH '$.rangeTo',
                   reward_code    VARCHAR(64)          PATH '$.rewardCode')) t;

        COMMIT;

        SELECT 0 AS RESULT;
        SELECT v_id AS ranking_id;
    END proc_block;
END$$
DELIMITER ;
