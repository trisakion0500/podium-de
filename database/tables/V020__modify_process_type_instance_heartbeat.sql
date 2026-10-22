-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : instance_heartbeat
-- 작성 : 2026.10.22 trisakion
-- 내용 : process_type에 3:ADMIN(관리 API, 01_DESIGN 10.4)을 추가해 COMMENT를 고친다. 타입은 같고 COMMENT만 바뀐다(메타데이터 변경).
-- ------------------------------------------------------------------------------------------------------------ --
ALTER TABLE `instance_heartbeat`
    MODIFY COLUMN `process_type` TINYINT UNSIGNED NOT NULL COMMENT '프로세스 유형 (1:API, 2:WORKER 워커, 3:ADMIN 관리 API) [codes.ProcessType]';
