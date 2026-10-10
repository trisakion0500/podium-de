DROP PROCEDURE IF EXISTS `SP_INSERT_LOG_RANKING_SUBMIT`;
DELIMITER $$
CREATE PROCEDURE `SP_INSERT_LOG_RANKING_SUBMIT` (
    IN i_ranking_id      INT UNSIGNED,        -- 랭킹 ID (메인 DB ranking_definition)
    IN i_season_no       INT UNSIGNED,        -- 요청의 seasonNo
    IN i_request_id      VARCHAR(64),         -- 게임 서버 requestId (멱등 키)
    IN i_member_id       VARCHAR(64),         -- 멤버 ID
    IN i_input_value     BIGINT,              -- 입력 값 (BEST:이번 기록, SUM:부호 있는 증분)
    IN i_result_code     INT UNSIGNED,        -- 처리 결과 (0:성공, 그 외 API 결과 코드)
    IN i_rejected        VARCHAR(32),         -- 하드 검증 거부 사유 (NULL:거부 아님)
    IN i_replayed        TINYINT(1),          -- 재전송 여부 (1:재전송, 0:최초)
    IN i_result_score    BIGINT UNSIGNED,     -- 처리 후 스코어 (SP까지 가지 않았으면 NULL)
    IN i_version         INT UNSIGNED,        -- 처리 후 entry version (SP까지 가지 않았으면 NULL)
    IN i_meta            JSON                 -- 게임 서버 맥락 (해석하지 않음, NULL 허용)
) COMMENT '제출 처리 이력 1건 기록 (로그 DB, 응답 후 별도 커넥션으로 호출)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_INSERT_LOG_RANKING_SUBMIT
    -- 작성 : 2026.10.04 trisakion
    -- 수정 : 2026.10.10 trisakion NOW(3) → UTC_TIMESTAMP(3) (호출 세션 time_zone과 무관하게 UTC, D-66)
    -- 내용 : 제출 API가 응답을 만든 뒤 로그 DB 전용 풀로 호출한다 (01_DESIGN 4.5, D-48).
    --        - 메인 트랜잭션과 묶이지 않는다. 실패해도 앱은 앱 로그 파일에 같은 내용을 남기고 응답에 영향을 주지 않는다.
    --        - 순수 적재 SP라 성공 시 두 번째 결과셋을 두지 않는다 (개발 컨벤션 4.4 예외).
    --        - created_at은 로그 DB 시각이며 일 파티션 키다. 파티션이 아직 없는 날은 p_max에 들어가 INSERT가 실패하지 않는다.
    --        - 입력 검증을 하지 않는다. 거부된 요청(잘못된 값 포함)도 그대로 남기는 것이 이 테이블의 목적이며,
    --          NOT NULL 위반 같은 형식 오류는 50001로 돌아가 앱 로그에 남는다.
    -- ------------------------------------------------------------------------------------------------------------ --
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

    INSERT INTO log_ranking_submit
        (created_at, ranking_id, season_no, request_id, member_id, input_value,
         result_code, rejected, replayed, result_score, version, meta)
    VALUES
        (UTC_TIMESTAMP(3), i_ranking_id, i_season_no, i_request_id, i_member_id, i_input_value,
         i_result_code, i_rejected, IFNULL(i_replayed, 0), i_result_score, i_version, i_meta);

    SELECT 0 AS RESULT;
END$$
DELIMITER ;
