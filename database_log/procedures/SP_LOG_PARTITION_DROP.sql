-- 2026.10.20 trisakion 삭제: 보관 기간이 지난 일 파티션은 지우지 않고 월 테이블로 옮긴다 (SP_LOG_PARTITION_ARCHIVE, 01_DESIGN 4.5).
-- 이미 설치된 DB에서 SP를 지우려고 DROP만 남긴다 (반복 마이그레이션의 삭제 방식).
DROP PROCEDURE IF EXISTS `SP_LOG_PARTITION_DROP`;
