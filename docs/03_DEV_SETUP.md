# 03_DEV_SETUP.md

# 로컬 개발 환경 설정

인프라 자동화(docker-compose 등)는 아직 이 레포의 범위가 아니다. 아래는 로컬에 이미 설치된
MySQL을 어떤 조건으로 준비해야 하는지에 대한 설명이다.

---

# 1. 사전 요구사항

| 항목 | 버전 |
|---|---|
| Node.js | 22 이상 — `process.loadEnvFile`(네이티브 `.env` 로딩)을 쓴다 |
| MySQL | 8.4 |
| Redis | 7.4 — 순위 반영과 조회에 필요하다. 없어도 API는 뜨고 제출은 MySQL에 저장된다 |
| Git | 최신 버전 |

---

# 2. 저장소 클론

```bash
git clone https://github.com/trisakion0500/podium-de.git
cd podium-de
npm install
```

---

# 3. MySQL 준비

## 3.1 스키마와 계정 생성

root 등 관리자 계정으로 실행한다. 스키마는 메인(`podium_de`)과 로그 DB(`podium_de_log`, 제출 이력) 둘이고, 계정은 둘로 나눈다. 로컬에서는 두 스키마를 같은 MySQL에 둔다.

| 계정 | 사용처 | 권한 |
|---|---|---|
| `podium_migrate` | `npm run migrate`, `npm run upgrade`, SP DEFINER | `podium_de`·`podium_de_log` 전체, `PROCESS` |
| `podium_app` | API, 워커 | `podium_de`·`podium_de_log` `EXECUTE`만 |

```sql
CREATE DATABASE `podium_de` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE `podium_de_log` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- migrate 계정 (SP DEFINER)
CREATE USER 'podium_migrate'@'localhost' IDENTIFIED BY '<migrate 비밀번호>';
CREATE USER 'podium_migrate'@'127.0.0.1' IDENTIFIED BY '<migrate 비밀번호>';
GRANT ALL PRIVILEGES ON podium_de.* TO 'podium_migrate'@'localhost', 'podium_migrate'@'127.0.0.1';
GRANT ALL PRIVILEGES ON podium_de_log.* TO 'podium_migrate'@'localhost', 'podium_migrate'@'127.0.0.1';
GRANT PROCESS ON *.* TO 'podium_migrate'@'localhost', 'podium_migrate'@'127.0.0.1';

-- 앱 계정 (SP 실행만)
CREATE USER 'podium_app'@'localhost' IDENTIFIED BY '<app 비밀번호>';
CREATE USER 'podium_app'@'127.0.0.1' IDENTIFIED BY '<app 비밀번호>';
GRANT EXECUTE ON podium_de.* TO 'podium_app'@'localhost', 'podium_app'@'127.0.0.1';
GRANT EXECUTE ON podium_de_log.* TO 'podium_app'@'localhost', 'podium_app'@'127.0.0.1';

-- 확인
SHOW GRANTS FOR 'podium_migrate'@'localhost';
SHOW GRANTS FOR 'podium_migrate'@'127.0.0.1';
SHOW GRANTS FOR 'podium_app'@'localhost';
SHOW GRANTS FOR 'podium_app'@'127.0.0.1';
```

이미 `podium_de`와 두 계정을 만들어 둔 환경이면 로그 DB 부분만 실행한다.

```sql
CREATE DATABASE `podium_de_log` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON podium_de_log.* TO 'podium_migrate'@'localhost', 'podium_migrate'@'127.0.0.1';
GRANT EXECUTE ON podium_de_log.* TO 'podium_app'@'localhost', 'podium_app'@'127.0.0.1';
```

- 호스트를 `localhost`와 `127.0.0.1` 둘 다 만드는 이유: MySQL은 소켓·named pipe 접속을
  `localhost`로, TCP 접속(`.env`의 `DB_HOST=127.0.0.1`)을 `127.0.0.1`로 구분해 매칭한다.
  다른 호스트에서 접속하는 배포 환경은 그 호스트(또는 `'%'`)로 만든다.
- SP는 `SQL SECURITY DEFINER`(기본값)이고 migrate 계정이 만들므로 DEFINER가 `podium_migrate`가
  된다. 앱 계정은 테이블 권한 없이 SP로만 접근한다.
- `PROCESS`는 정산 전 미종료 트랜잭션 확인(`INNODB_TRX` 조회)에 필요하다. 이 조회는 SP 안에서
  하므로 DEFINER인 migrate 계정이 권한을 가진다. 상세: [01_DESIGN 7.1](01_DESIGN.md#71-정산-시작-조건)

---

# 4. 백엔드 설정

## 4.1 환경변수 설정

```bash
cp .env.example .env
```

`.env`를 열어 3.1에서 만든 계정을 `DB_APP_USER`/`DB_APP_PASSWORD`,
`DB_MIGRATE_USER`/`DB_MIGRATE_PASSWORD`에 채운다. 변수별 설명은 `.env.example`의 주석 참고.
API·워커만 실행하는 호스트의 `.env`에는 `DB_MIGRATE_*`를 두지 않는다.
로그 DB는 별도 DB라 접속 정보(`DB_LOG_HOST`, `DB_LOG_PORT`, `DB_LOG_NAME`)와 계정
(`DB_LOG_APP_*`, `DB_LOG_MIGRATE_*`)을 따로 채운다. 비어 있으면 기동하지 않는다. 로컬은 같은 MySQL과
3.1의 같은 계정을 그대로 적으면 된다. API·워커만 실행하는 호스트에는 `DB_LOG_MIGRATE_*`도 두지 않는다.
Redis 접속은 `REDIS_URL`, `REDIS_PASSWORD`에 채운다. 다른 서비스와 같은 Redis를 쓰면 `REDIS_KEY_PREFIX`(예: `ped:`)를
지정한다. Redis가 없어도 API는 기동하며 제출은 MySQL에만 반영된다.

## 4.2 빌드, 마이그레이션, 실행

```bash
npm run build          # tsc → dist/
npm run migrate        # 테이블·SP 적용 (migrate 계정)
npm run start:api      # API 실행 (http://localhost:3000, API_PORT로 변경 가능)
                       # API_DOCS=1이면 http://localhost:3000/docs 에 Swagger UI
npm run start:worker   # 워커 실행
```

로컬에서는 API와 워커를 터미널 두 개에서 직접 띄우고 Ctrl+C로 끈다(정상 종료 처리됨).
`.env`의 `UPGRADE_STOP_CMD`/`UPGRADE_START_CMD`는 비워 두며, 이 상태에서 `npm run upgrade`는
아무것도 멈추지 않고 중단한다. DB 변경(테이블·SP)을 반영할 때는 둘 다 끄고 → `npm run build` →
`npm run migrate` → 다시 띄운다.

API·워커는 기동 시 DB 스키마가 패키지와 같은지 확인만 하고, 다르면 기동하지 않는다.
적용은 `npm run migrate`로만 한다. 마이그레이션 규칙과 배포 절차는 README의
[실행 방법](../README.md#실행-방법) 참고.

## 4.3 Swagger로 호출해 보기

1. `.env`에 `API_DOCS=1`을 두고 API를 띄운 뒤 http://localhost:3000/docs 를 연다.
2. API 키를 발급한다. 키 원문은 이때 한 번만 출력된다.
   ```bash
   npm run credential -- create swagger-test write,read   # 제출은 write, 조회는 read
   ```
3. 화면 오른쪽 위 **Authorize**에 키를 넣는다. 이후 요청에 `x-api-key` 헤더가 붙는다.
   API는 키 목록을 30초마다 다시 읽으므로 발급 직후 잠깐은 401이 날 수 있다.
4. 제출·조회에는 진행 중인 시즌과 Redis 센티넬이 있는 랭킹이 필요하다. 스케줄러가 생기기 전에는
   `node loadtest/load.mjs setup`으로 테스트 랭킹 931(BEST)·932(SUM)를 만들어 쓰고,
   끝나면 `node loadtest/load.mjs clean`으로 지운다.

---

# 5. 실행 확인

| 항목 | 확인 방법 |
|---|---|
| DB 연결·스키마 | 기동 로그에 `heartbeat started: <ID> ...`가 남고 프로세스가 종료되지 않는다 |
| 미적용 DB | `<SP 이름>이(가) DB에 없습니다. npm run migrate가 필요합니다.`로 기동이 거부된다 |
| 로그 DB | 접속되면 메인과 같이 확인된다. 접속할 수 없으면 `log DB(podium_de_log) unreachable ...` 경고만 남고 기동은 계속된다. 계정·DB 이름이 틀리면 `로그 DB(...) 접속 설정이 잘못되었습니다`로 기동이 거부된다 |
| API 헬스체크 | `curl http://localhost:3000/health` → `{"result":0}` |
