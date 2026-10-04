-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : log_ddl_audit (로그 DB podium_de_log)
-- 작성 : 2026.10.02 trisakion
-- 내용 : 로그 DB SP_EXEC_DDL 실행 감사 로그 (01_DESIGN 4.5, 11.2, D-48). 메인 DB log_ddl_audit와 같은 구조다.
--        SP_EXEC_DDL은 DB마다 하나이고 감사 로그를 같은 DB에 기록해야 하므로(별도 인스턴스일 수 있음) 로그 DB에도 둔다.
--        DDL은 암묵적으로 커밋되므로 실행 전에 행을 먼저 기록하고, 실행 후 status·finished_at·오류 정보를 갱신한다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `log_ddl_audit` (
    `log_ddl_audit_id`    BIGINT          UNSIGNED    NOT NULL    AUTO_INCREMENT    COMMENT '감사 로그 ID',
    `sql_text`            TEXT                        NOT NULL                      COMMENT '실행한 DDL',
    `status`              TINYINT         UNSIGNED    NOT NULL                      COMMENT '상태 (0:RUNNING 실행 중 또는 중단, 1:SUCCEEDED 성공, 2:FAILED 실패) [codes.DdlAuditStatus]',
    `started_at`          DATETIME(3)                 NOT NULL                      COMMENT '실행 시작 시각 (UTC)',
    `finished_at`         DATETIME(3)                             DEFAULT NULL      COMMENT '실행 종료 시각 (UTC, NULL:실행 중 또는 중단)',
    `sql_state`           CHAR(5)                                 DEFAULT NULL      COMMENT '실패 시 SQLSTATE',
    `error_no`            INT             UNSIGNED                DEFAULT NULL      COMMENT '실패 시 MySQL 에러 번호',
    `error_message`       VARCHAR(512)                            DEFAULT NULL      COMMENT '실패 시 에러 메시지',
    PRIMARY KEY (`log_ddl_audit_id`),
    KEY `ix_started_at` (`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='로그 DB SP_EXEC_DDL 실행 감사 로그';
