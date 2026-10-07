DROP PROCEDURE IF EXISTS `SP_UPSERT_INSTANCE_HEARTBEAT`;
DELIMITER $$
CREATE PROCEDURE `SP_UPSERT_INSTANCE_HEARTBEAT` (
    IN i_instance_id     CHAR(36),            -- 인스턴스 ID (기동마다 생성한 UUID)
    IN i_process_type    TINYINT UNSIGNED,    -- 프로세스 유형 (1:API, 2:WORKER) [codes.ProcessType]
    IN i_app_version     VARCHAR(32)          -- 실행 중인 패키지 버전 (package.json version)
) COMMENT '인스턴스 하트비트 기록(DB 시각)과 1시간 넘게 갱신 없는 행 정리'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_UPSERT_INSTANCE_HEARTBEAT
    -- 작성 : 2026.10.04 trisakion
    -- 수정 : 2026.10.07 trisakion 정리 DELETE에 ORDER BY 추가 (STATEMENT binlog 안전)
    -- 내용 : API·워커가 기동 시와 10초마다 호출한다 (01_DESIGN 11.4, heartbeat.ts).
    --        - last_seen_at은 DB 시각이다. migrate가 같은 DB 시각으로 "최근 30초"를 비교하므로 호스트 시계 차이와 무관하다.
    --        - 같은 instance_id는 같은 프로세스이므로 last_seen_at만 갱신한다.
    --        - 비정상 종료로 남은 행(1시간 경과)을 함께 지운다. 정리 전용 잡을 따로 두지 않기 위해서다.
    --          LIMIT으로 한 번에 지우는 양을 제한해 하트비트 호출이 길어지지 않게 한다. 남은 행은 다음 주기에 지운다.
    --        - 두 문장은 각자 자동 커밋된다. 기록과 정리를 한 트랜잭션으로 묶을 이유가 없고, 묶으면 다른 인스턴스의
    --          기록과 잠금이 겹치는 시간만 길어진다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_now              DATETIME(3)     DEFAULT NOW(3);
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
        IF i_instance_id IS NULL OR CHAR_LENGTH(i_instance_id) <> 36
           OR i_process_type IS NULL OR i_process_type NOT IN (1, 2)
           OR i_app_version IS NULL OR i_app_version = '' THEN
            SELECT 1001 AS RESULT;
            LEAVE proc_block;
        END IF;

        INSERT INTO instance_heartbeat (instance_id, process_type, app_version, last_seen_at)
        VALUES (i_instance_id, i_process_type, i_app_version, v_now) AS n
        ON DUPLICATE KEY UPDATE last_seen_at = n.last_seen_at;

        -- ORDER BY: LIMIT만 있으면 지울 행이 실행마다 달라질 수 있어 STATEMENT binlog에서 unsafe로 경고된다.
        DELETE FROM instance_heartbeat
         WHERE last_seen_at < v_now - INTERVAL 1 HOUR
         ORDER BY last_seen_at
         LIMIT 100;

        SELECT 0 AS RESULT;
    END proc_block;
END$$
DELIMITER ;
