CREATE DATABASE `podium_de` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;

-- migrate 계정 (SP DEFINER)
CREATE USER 'podium_migrate'@'localhost' IDENTIFIED BY '[PASSWORD-1]';
CREATE USER 'podium_migrate'@'127.0.0.1' IDENTIFIED BY '[PASSWORD-1]';
GRANT ALL PRIVILEGES ON podium_de.* TO 'podium_migrate'@'localhost', 'podium_migrate'@'127.0.0.1';
GRANT PROCESS ON *.* TO 'podium_migrate'@'localhost', 'podium_migrate'@'127.0.0.1';

-- 앱 계정 (SP 실행만)
CREATE USER 'podium_app'@'localhost' IDENTIFIED BY '[PASSWORD-2]';
CREATE USER 'podium_app'@'127.0.0.1' IDENTIFIED BY '[PASSWORD-2]';
GRANT EXECUTE ON podium_de.* TO 'podium_app'@'localhost', 'podium_app'@'127.0.0.1';

-- 확인
SHOW GRANTS FOR 'podium_migrate'@'localhost';
SHOW GRANTS FOR 'podium_app'@'localhost';
SHOW GRANTS FOR 'podium_migrate'@'localhost';
SHOW GRANTS FOR 'podium_app'@'127.0.0.1';


이거 디비 및 계정 생성 쿼리다.
문서화 해야 할듯..