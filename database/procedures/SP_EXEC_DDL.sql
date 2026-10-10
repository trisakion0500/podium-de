DROP PROCEDURE IF EXISTS `SP_EXEC_DDL`;
DELIMITER $$
CREATE PROCEDURE `SP_EXEC_DDL` (
    IN i_sql    TEXT    -- 실행할 DDL 한 문장 (관리 SP가 숫자 파라미터와 고정 이름으로만 조립한 문자열)
) SQL SECURITY INVOKER COMMENT '동적 DDL의 유일한 PREPARE 지점. 감사 로그 기록 후 실행, 실패 시 RESIGNAL (관리 SP 내부 전용)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : SP_EXEC_DDL
    -- 작성 : 2026.10.04 trisakion
    -- 수정 : 2026.10.10 trisakion NOW(3) → UTC_TIMESTAMP(3) (호출 세션 time_zone과 무관하게 UTC, D-66)
    -- 내용 : 메인 DB(podium_de)에서 PREPARE를 쓰는 유일한 SP다 (01_DESIGN 11.2, D-25). 관리 SP만 호출한다.
    --        로그 DB에도 본문이 같은 SP가 있다(DB마다 하나, D-48). 한쪽을 고치면 다른 쪽도 함께 고친다.
    --        - SQL SECURITY INVOKER: 앱 계정은 스키마 단위 EXECUTE를 가지므로 이 SP를 직접 CALL할 수 있다.
    --          INVOKER로 두면 직접 호출 시 앱 계정 권한으로 실행되어 감사 로그 INSERT와 DDL이 권한 오류로 실패한다.
    --          관리 SP(DEFINER) 안에서 호출되면 호출자 보안 문맥, 즉 DEFINER(migrate 계정) 권한으로 실행된다.
    --          DEFINER로 두면 앱 계정 탈취만으로 임의 DDL(DROP TABLE 등)을 실행할 수 있게 된다 (D-44 위반).
    --        - 감사 로그는 실행 전에 기록하고 커밋한다. DDL은 암묵적으로 커밋되므로 실행 후에만 남기면
    --          실행 중 세션이 끊긴 경우 흔적이 없다. status = 0으로 남은 행이 그 흔적이다.
    --        - lock_wait_timeout을 2초로 줄여 실행한다 (01_DESIGN 11.1). 운영 테이블 DDL이 배타 MDL을 오래 기다리면
    --          그 뒤의 모든 랭킹 쓰기가 줄을 선다. 1205로 실패하면 호출한 잡이 상태를 다시 관측해 재시도한다.
    --          세션 값은 성공·실패 모두 원래대로 돌려 놓는다 (풀 커넥션이 재사용되므로).
    --        - 실패는 RESULT로 알리지 않고 RESIGNAL한다 (D-36). RESULT를 SELECT하면 호출한 관리 SP의 결과셋이 이중으로 나간다.
    --        - 지역 변수에 v_ 접두를 붙인다. log_ddl_audit 컬럼(sql_state 등)과 이름이 같으면 UPDATE에서 변수로 해석된다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_audit_id         BIGINT UNSIGNED    DEFAULT NULL;
    DECLARE v_prepared         TINYINT(1)         DEFAULT 0;
    DECLARE v_lock_wait        BIGINT UNSIGNED    DEFAULT @@SESSION.lock_wait_timeout;
    DECLARE v_sql_state        CHAR(5)            DEFAULT '00000';
    DECLARE v_error_no         INT UNSIGNED       DEFAULT 0;
    DECLARE v_error_message    VARCHAR(512)       DEFAULT '';
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            v_sql_state = RETURNED_SQLSTATE, v_error_no = MYSQL_ERRNO, v_error_message = MESSAGE_TEXT;
        -- PREPARE 전에 실패했으면 해제할 문장이 없다. 없는 문장을 DEALLOCATE하면 핸들러 안에서 새 오류가 난다.
        IF v_prepared = 1 THEN
            DEALLOCATE PREPARE podium_ddl_stmt;
        END IF;
        SET @podium_ddl_sql = NULL;
        SET SESSION lock_wait_timeout = v_lock_wait;
        -- 감사 로그 INSERT 자체가 실패했으면(직접 호출 등) 갱신할 행이 없다.
        IF v_audit_id IS NOT NULL THEN
            UPDATE log_ddl_audit
               SET status = 2, finished_at = UTC_TIMESTAMP(3), sql_state = v_sql_state, error_no = v_error_no, error_message = v_error_message
             WHERE log_ddl_audit_id = v_audit_id;
            COMMIT;
        END IF;
        -- 인자 없는 RESIGNAL은 핸들러 진입 시점의 원래 오류(errno 포함)를 그대로 다시 던진다. 호출자는 1205 등으로 재시도를 판단한다.
        RESIGNAL;
    END;

    IF i_sql IS NULL OR TRIM(i_sql) = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SP_EXEC_DDL: empty statement';
    END IF;

    INSERT INTO log_ddl_audit (sql_text, status, started_at)
    VALUES (i_sql, 0, UTC_TIMESTAMP(3));
    SET v_audit_id = LAST_INSERT_ID();
    COMMIT;

    SET SESSION lock_wait_timeout = 2;
    -- PREPARE는 지역 변수를 받지 않으므로 세션 변수를 거친다. 실행 후 비워 다음 호출에 남기지 않는다.
    SET @podium_ddl_sql = i_sql;
    PREPARE podium_ddl_stmt FROM @podium_ddl_sql;
    SET v_prepared = 1;
    EXECUTE podium_ddl_stmt;
    DEALLOCATE PREPARE podium_ddl_stmt;
    SET v_prepared = 0;
    SET @podium_ddl_sql = NULL;
    SET SESSION lock_wait_timeout = v_lock_wait;

    UPDATE log_ddl_audit
       SET status = 1, finished_at = UTC_TIMESTAMP(3)
     WHERE log_ddl_audit_id = v_audit_id;
    COMMIT;
END$$
DELIMITER ;
