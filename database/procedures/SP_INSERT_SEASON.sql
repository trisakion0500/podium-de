DROP PROCEDURE IF EXISTS `SP_INSERT_SEASON`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_SEASON` (
    IN i_ranking_id    INT UNSIGNED,    -- 랭킹 ID (1 이상)
    IN i_season_no     INT UNSIGNED,    -- 시즌 번호 (1 또는 마지막 시즌 + 1)
    IN i_start_at      DATETIME(3),     -- 시즌 시작 시각 (UTC, 포함. 앱이 timezone 경계로 계산)
    IN i_end_at        DATETIME(3)      -- 시즌 종료 시각 (UTC, 미포함)
) COMMENT '시즌 행 하나를 SCHEDULED로 추가. 이미 있으면 성공으로 봄 (멱등)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_SEASON
    -- 작성 : 2026.10.10 trisakion
    -- 내용 : 워커 스케줄러가 시즌 행을 미리 만든다 (01_DESIGN 3.3). 파티션은 이어서 SP_PARTITION_ADD가 추가한다 —
    --        DDL은 암묵적으로 커밋하므로 같은 SP에 두지 않는다.
    --        RESULT: 0 성공(이미 있음 포함), 1001 파라미터(랭킹 없음, 시각 순서 포함), 1002 앞 시즌 없음 [codes.SpResult]
    --
    --        - 시각 계산은 앱이 하고 SP는 순서만 지킨다: 번호는 이어져야 하고(앞 시즌이 있어야 함), 시작은 앞 시즌
    --          종료 이후여야 한다. 시즌이 겹치면 제출의 시각 검사(4.1)가 두 시즌을 동시에 받는다.
    --        - settle_at = end_at + settle_delay. 정의의 settle_delay는 등록 후 바꿀 수 있어도 이미 만든 시즌은 그대로다.
    --        - 같은 번호가 이미 있으면 성공이다. 스케줄러는 락으로 하나만 돌지만 재시도와 수동 호출이 겹쳐도 같다.
    --          확인과 INSERT 사이에 다른 세션이 먼저 넣으면 1062를 받아 같은 결과로 처리한다.
    --        - 단독 자동 커밋 한 문장이다. ranking_definition은 잠그지 않는 일반 SELECT로만 읽는다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_settle_delay     INT UNSIGNED;
    DECLARE v_prev_end         DATETIME(3);
    DECLARE sql_state          CHAR(5)         DEFAULT '00000';
    DECLARE error_no           INT             DEFAULT 0;
    DECLARE error_message      VARCHAR(512)    DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            sql_state = RETURNED_SQLSTATE, error_no = MYSQL_ERRNO, error_message = MESSAGE_TEXT;
        SELECT 50001 AS RESULT, sql_state AS SQL_STATE, error_no AS ERROR_NO, error_message AS ERROR_MESSAGE;
    END;

    proc_block: BEGIN
        IF i_ranking_id IS NULL OR i_ranking_id = 0 OR i_season_no IS NULL OR i_season_no = 0
           OR i_start_at IS NULL OR i_end_at IS NULL OR i_start_at >= i_end_at THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT settle_delay INTO v_settle_delay FROM ranking_definition WHERE ranking_id = i_ranking_id;
        IF v_settle_delay IS NULL THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        IF EXISTS (SELECT 1 FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no) THEN
            SELECT 0 AS RESULT;
            LEAVE proc_block;
        END IF;

        IF i_season_no > 1 THEN
            SELECT end_at INTO v_prev_end FROM ranking_season WHERE ranking_id = i_ranking_id AND season_no = i_season_no - 1;
            IF v_prev_end IS NULL THEN
                SELECT 1002 AS RESULT;
                LEAVE proc_block;
            END IF;
            IF i_start_at < v_prev_end THEN
                SELECT 1001 AS RESULT;
                LEAVE proc_block;
            END IF;
        END IF;

        BEGIN
            DECLARE CONTINUE HANDLER FOR 1062 BEGIN END;
            INSERT INTO ranking_season (ranking_id, season_no, start_at, end_at, settle_at, status)
            VALUES (i_ranking_id, i_season_no, i_start_at, i_end_at, i_end_at + INTERVAL v_settle_delay SECOND, 1);
        END;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
