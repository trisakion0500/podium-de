-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : admin_session
-- 작성 : 2026.10.31 trisakion
-- 내용 : admin_account_id COMMENT에 참조 대상과 FK 없음을 적는다 (01_DESIGN 10.4). V021에서 FK를 지울 때 COMMENT를 그대로 둬
--        설계 DDL과 달라졌다. 다른 테이블의 ID 컬럼과 같은 "(참조 테이블, FK 없음)" 형식이다. 타입·NULL 여부는 바꾸지 않는다.
-- ------------------------------------------------------------------------------------------------------------ --
ALTER TABLE `admin_session`
    MODIFY COLUMN `admin_account_id` INT UNSIGNED NOT NULL COMMENT 'GM 계정 ID (admin_account, FK 없음)';
