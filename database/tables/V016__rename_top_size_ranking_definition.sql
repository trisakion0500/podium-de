-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : ranking_definition
-- 작성 : 2026.10.08 trisakion
-- 내용 : hall_size를 top_size로 이름 변경 (D-59). 타입·기본값은 같고 이름과 COMMENT만 바뀐다(메타데이터 변경).
-- ------------------------------------------------------------------------------------------------------------ --
ALTER TABLE `ranking_definition`
    CHANGE COLUMN `hall_size` `top_size` SMALLINT UNSIGNED NOT NULL DEFAULT 100 COMMENT 'ranking_season_top에 영구 보관할 시즌별 상위 인원';
