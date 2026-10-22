-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : admin_session
-- 작성 : 2026.10.22 trisakion
-- 내용 : admin_account FK를 지운다. 이 프로젝트의 테이블은 FK를 두지 않는다(04_SCHEMA 2장) — 관계는 SP가 지킨다.
--        세션은 SP_INSERT_ADMIN_SESSION·SP_UPDATE_ADMIN_PASSWORD가 계정 행을 FOR UPDATE로 잠근 뒤에만 만들고,
--        계정은 지우지 않으므로 고아 세션이 생기지 않는다. 계정별 정리에 쓰는 ix_admin_account_id는 남긴다.
-- ------------------------------------------------------------------------------------------------------------ --
ALTER TABLE `admin_session` DROP FOREIGN KEY `fk_admin_session_account`;
