DROP PROCEDURE IF EXISTS `SP_GET_CURRENT_SEASON`;
DELIMITER $$
CREATE PROCEDURE `SP_GET_CURRENT_SEASON` (
    IN i_ranking_id    INT UNSIGNED  -- 랭킹 ID (1 이상)
) COMMENT '지금 시각이 [start_at, end_at)에 드는 시즌 조회 (순위 조회 API의 현재 시즌 캐시용)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_GET_CURRENT_SEASON
    -- 작성 : 2026.10.07 trisakion
    -- 수정 : 2026.10.09 trisakion 센티넬 준비 시점 주석 갱신 (D-60)
    -- 수정 : 2026.10.10 trisakion NOW(3) → UTC_TIMESTAMP(3) (호출 세션 time_zone과 무관하게 UTC, D-66)
    -- 내용 : 01_DESIGN 5.4, 10.2. API가 랭킹별로 읽어 end_at까지 메모리에 둔다.
    --        RESULT: 0 성공, 1001 파라미터, 1301 현재 시즌 없음 [codes.SpResult]
    --        성공 데이터: season_no, start_at(composite 디코드용), end_at(캐시 만료)
    --
    --        - 현재 시즌은 상태가 아니라 시각으로 정한다. 제출(SP_SUBMIT_SCORE)이 시각으로 받으므로 같은 기준이어야
    --          조회와 제출이 가리키는 시즌이 어긋나지 않는다(3.5). Redis 센티넬이 아직 없으면(준비 전 — 워커 정지,
    --          시즌 행 지연) 앱이 2007로 응답한다. 센티넬은 복구 잡이 시작 60초 전에 미리 세운다(D-60).
    --        - PK (ranking_id, season_no) 역순으로 읽어 처음 맞는 행에서 멈춘다. 미래 시즌은 미리 만든 몇 개뿐이라
    --          시즌이 많이 쌓인 랭킹도 몇 행만 읽는다.
    --        - 잠그지 않는 일반 SELECT라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT UTC_TIMESTAMP(3);
    DECLARE v_season_no        INT UNSIGNED;
    DECLARE v_start_at         DATETIME(3);
    DECLARE v_end_at           DATETIME(3);
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
        IF i_ranking_id IS NULL OR i_ranking_id = 0 THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT season_no, start_at, end_at
          INTO v_season_no, v_start_at, v_end_at
          FROM ranking_season
         WHERE ranking_id = i_ranking_id AND start_at <= v_now AND end_at > v_now
         ORDER BY season_no DESC
         LIMIT 1;
        IF v_season_no IS NULL THEN
            SELECT 1301 AS RESULT;
            LEAVE proc_block;
        END IF;

        SELECT 0 AS RESULT;
        SELECT v_season_no AS season_no, v_start_at AS start_at, v_end_at AS end_at;
    END proc_block;
END$$
DELIMITER ;
