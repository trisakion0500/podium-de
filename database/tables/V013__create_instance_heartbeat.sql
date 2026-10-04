-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : instance_heartbeat
-- 작성 : 2026.10.02 trisakion
-- 내용 : 실행 중인 API·워커 인스턴스 (01_DESIGN 11.4). 10초마다 갱신하고 정상 종료 시 삭제한다.
--        migrate는 최근 30초 안의 행이 있으면 거부한다 (D-39). 1시간 넘게 갱신 없는 행은 하트비트 SP가 함께 정리한다.
--        instance_id는 기동마다 생성하는 UUID다(PID 재사용으로 다른 인스턴스 행을 덮어쓰는 것 방지).
--        UUID는 ASCII라 ascii 문자셋으로 키 크기를 줄인다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `instance_heartbeat` (
    `instance_id`     CHAR(36)       CHARACTER SET ascii COLLATE ascii_bin    NOT NULL        COMMENT '인스턴스 ID (기동마다 생성하는 UUID)',
    `process_type`    TINYINT        UNSIGNED                                 NOT NULL        COMMENT '프로세스 유형 (1:API, 2:WORKER 워커) [codes.ProcessType]',
    `app_version`     VARCHAR(32)                                             NOT NULL        COMMENT '실행 중인 패키지 버전 (package.json version)',
    `last_seen_at`    DATETIME(3)                                             NOT NULL        COMMENT '마지막 하트비트 시각 (UTC, DB 시각)',
    PRIMARY KEY (`instance_id`),
    KEY `ix_last_seen_at` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='실행 중인 API·워커 인스턴스 하트비트';
