-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_definition
-- 작성 : 2026.10.23 trisakion
-- 내용 : ranking_id를 AUTO_INCREMENT로 바꾸고 time_bits COMMENT를 고친다 (D-81).
--        관리 API 등록은 ID를 DB가 정한다. 테스트처럼 ID를 지정한 INSERT도 계속 된다(다음 값은 최댓값 + 1부터).
--        time_bits는 등록 시 53 − bits(score_max)로 정한다. 남는 비트를 모두 시간에 줘 end_at 연장 여유를 키운다.
--        AUTO_INCREMENT 추가는 테이블을 복사하지만 정의 테이블은 랭킹 수만큼이라 작다. DB 변경 배포는 중단 패치다(D-38).
-- ------------------------------------------------------------------------------------------------------------ --
ALTER TABLE `ranking_definition`
    MODIFY COLUMN `ranking_id` INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '랭킹 ID (1부터)',
    MODIFY COLUMN `time_bits` TINYINT UNSIGNED NOT NULL COMMENT 'composite score의 시간 비트 수 (등록 시 53 − bits(score_max), 불변)';
