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
| Redis | 7.4 — 순위 반영과 조회에 필요하다. 없어도 API는 뜨고 제출은 MySQL에 저장된다. `maxmemory-policy noeviction`으로 두고, `maxmemory`는 진행 중인 시즌 키 합 + 가장 큰 시즌 하나 이상으로 잡는다([01_DESIGN 1.7](01_DESIGN.md#s-1-7)). 로컬도 같다 — 재구축 중 축출되면 순위표가 조용히 빈다 |
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
| `podium_app` | API, 워커, 관리 API | `podium_de`·`podium_de_log` `EXECUTE`만 |

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

-- 서버 설정: migrate 계정이 Function을 만들 수 있게 한다 (binlog가 켜진 MySQL, D-80)
SET PERSIST log_bin_trust_function_creators = 1;

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
  하므로 DEFINER인 migrate 계정이 권한을 가진다. 상세: [01_DESIGN 7.1](01_DESIGN.md#s-7-1)
- `log_bin_trust_function_creators`: 없으면 `npm run migrate`가 Function(`FN_GET_ADMIN_ROLE`)에서 1419로 멈춘다. `binlog_format = ROW`(기본값)에서는 복제 안전에 영향이 없다 ([D-80](02_DECISIONS.md#d-80)).
- 서버 시간대와 시간 동기화는 아래 "시간대와 시간 동기화"를 따른다.

### 시간대와 시간 동기화

모든 시각은 UTC로 저장·비교한다([01_DESIGN 4.1](01_DESIGN.md#s-4-1), [D-66](02_DECISIONS.md#d-66)). VM 시간대는 아래처럼 둔다.

| VM | OS 시간대 | 비고 |
| --- | --- | --- |
| DB | UTC 권장, DST 없는 시간대 가능 | DST 시간대 금지 (`INNODB_TRX` 변환). `default-time-zone`은 기본값, 시간대 테이블 불필요 |
| API·워커 | 무관 | 앱이 TZ=UTC로 고정 |
| Redis | 무관 | |

- 모든 VM은 NTP로 시간을 맞춘다(오차 1초 이내). API는 현재 시즌 캐시 만료를 앱 시계로 판단해, 시계가 늦으면 경계 직후 그만큼 지난 시즌을 보여 준다.

---

# 4. 백엔드 설정

## 4.1 환경변수 설정

```bash
cp .env.example .env
```

`.env`를 열어 3.1에서 만든 계정을 `DB_APP_USER`/`DB_APP_PASSWORD`,
`DB_MIGRATE_USER`/`DB_MIGRATE_PASSWORD`에 채운다. 변수별 설명은 `.env.example`의 주석 참고.
API·워커·관리 API만 실행하는 호스트의 `.env`에는 `DB_MIGRATE_*`를 두지 않는다. 관리 CLI(`npm run admin`)는 migrate 계정을 쓴다.
로그 DB는 별도 DB라 접속 정보(`DB_LOG_HOST`, `DB_LOG_PORT`, `DB_LOG_NAME`)와 계정
(`DB_LOG_APP_*`, `DB_LOG_MIGRATE_*`)을 따로 채운다. 비어 있으면 기동하지 않는다. 로컬은 같은 MySQL과
3.1의 같은 계정을 그대로 적으면 된다. API·워커·관리 API만 실행하는 호스트에는 `DB_LOG_MIGRATE_*`도 두지 않는다.
Redis 접속은 `REDIS_URL`, `REDIS_PASSWORD`에 채운다. 다른 서비스와 같은 Redis를 쓰면 `REDIS_KEY_PREFIX`(예: `ped:`)를
지정한다. Redis가 없어도 API는 기동하며 제출은 MySQL에만 반영된다.

## 4.2 빌드, 마이그레이션, 실행

```bash
npm run build          # tsc → dist/
npm run migrate        # 테이블·SP 적용 (migrate 계정)
npm run start:api      # API 실행 (http://localhost:3000, API_PORT로 변경 가능)
                       # API_DOCS=1이면 http://localhost:3000/docs 에 Swagger UI
npm run start:worker   # 워커 실행
npm run start:admin    # 관리 API 실행 (http://localhost:3200, ADMIN_PORT로 변경 가능)
```

관리 API에 처음 로그인하려면 admin 계정을 CLI로 만든다. 초기 비밀번호는 이때 한 번만 출력되고, 첫 로그인 때 바꿔야 한다.

```bash
npm run admin -- create --login-id <아이디> --name <이름>
npm run admin -- reset-password --login-id <아이디>   # 모든 admin이 비밀번호를 잃었거나 잠겼을 때
```

세션 쿠키에 `Secure`가 붙으므로 브라우저는 HTTPS나 `localhost`에서만 쿠키를 보낸다. 브라우저에서 쓰기 요청을 보내려면 `ADMIN_ORIGINS`에 화면 주소를 넣는다.

로컬에서는 API·워커(필요하면 관리 API)를 터미널마다 직접 띄우고 Ctrl+C로 끈다(정상 종료 처리됨).
`.env`의 `UPGRADE_STOP_CMD`/`UPGRADE_START_CMD`는 비워 두며, 이 상태에서 `npm run upgrade`는
아무것도 멈추지 않고 중단한다. DB 변경(테이블·SP)을 반영할 때는 모두 끄고 → `npm run build` →
`npm run migrate` → 다시 띄운다.

API·워커·관리 API는 기동 시 DB 스키마가 패키지와 같은지 확인만 하고, 다르면 기동하지 않는다.
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
4. 제출·조회에는 진행 중인 시즌과 Redis 센티넬이 있는 랭킹이 필요하다. 센티넬은 워커가 시즌 시작 60초 전부터 만든다.
   시즌은 워커 스케줄러가 랭킹 정의로 만든다. 랭킹은 관리 API(`POST /admin/v1/rankings`, [01_DESIGN 10.4](01_DESIGN.md#s-10-4))로 등록한다.
   빠르게 확인할 때는 `node loadtest/load.mjs setup`으로 테스트 랭킹 931(BEST)·932(SUM)를 만들어 쓰고, 끝나면 `node loadtest/load.mjs clean`으로 지운다.

## 4.4 회귀 테스트

```powershell
npm run build
node tests/recovery.mjs      # 기본 3회 반복, 약 8분
```

로컬 DB·Redis에서 워커·API를 직접 띄워 확인한다. 테스트 랭킹 940\~971을 쓰고 끝나면 지운다(시즌 백업 테이블 포함). API 포트는 TEST_PORT(기본 3199)부터 6개(3199\~3204)를 쓴다. 끝난 뒤 30초 동안은 migrate가 거부된다(강제 종료로 남은 하트비트).
관리 API는 그다음 포트(3205)를 쓰고, `rtest-`로 시작하는 관리 계정·세션·감사 로그를 만들고 지운다.
고치는 중에는 `ONLY=관리`처럼 구간 이름 일부를 주면 그 구간만 돈다(PowerShell: `$env:ONLY='관리'`). 커밋 전에는 전체를 돌린다.
`KEEP_BACKUP_TABLES=1`로 실행하면 테스트가 만든 시즌 백업 테이블을 남긴다(확인용, 랭킹 정의·시즌 행은 지워진다). 다음 실행 시작 때 지워진다.

진행 상황은 구간 시작·끝의 `[mm:ss]` 경과 시간과 30초마다 찍는 `... 진행 중: run N / 구간` 하트비트로 본다. 출력이 30초 넘게 멈추면 그 자리에서 멈춘 것이다. 구간이 5분을 넘거나 예외가 나면 `ABORTED`와 요약을 찍고 종료 코드 1로 끝난다. 워커·API가 스스로 종료하면(스키마 불일치로 기동 거부 등) err 로그의 마지막 ERROR 줄과 함께 FAIL로 찍는다.
테스트가 도는 동안 SP·소스를 고치지 않는다. 새로 뜨는 워커·API가 스키마 불일치로 기동을 거부해 엉뚱한 구간이 실패한다.

| 구분 | 내용 |
| --- | --- |
| 복구 (S, L, A) | Redis를 강제로 어긋나게 만들고 L1~L3·보조 점검으로 복구되는지, API 응답까지 |
| 스케줄러 (C, G) | 시즌 경계 계산(timezone, DST, MONTHLY 시작일 제한), 선행 생성, 상태 전이, 빠진 파티션 채우기, 세션 +09:00에서도 UTC 기록 |
| 정산 (T) | 시작 조건(1010·1011), 가순위가 마감 Redis 순서와 일치, 중단 후 이어받기, 빈 시즌, Redis 키 삭제, 작업 테이블 원상복구 |
| 확정 (F) | 보류·검수 기간 전 거부(1014), 중단 후 이어받기, 제재 제외 후 순위 연속, 보상 구간(RANK·PERCENT·겹침·경계, 참가자 1명, RANK 우선, 공백 계산), 스냅샷 고정, Top N, 빈 시즌, 도중 제재 추가, 미완료 전이 거부(1015), 재호출 멱등, 전원 제재, 참가자 < top_size |
| 보상 전달 (R) | 결과·내 결과·Top N 페이지, 확정 전 1003·시즌 없음 1002, 보상 목록 커서(보류·제재 제외), 권한(2003), 대기 시즌 남은 건수, ack 멱등(notApplied, delivered_at 유지, 1001개 거부), 남은 대상 0 → SETTLED(빈 시즌 포함), ack 정체·적체 경고 판정, 오류 주입(동시 중복 ack, 락 대기로 2005 뒤 커밋, 데드락 50001 후 재시도, 워커 실제 경고·해소 로그) |
| 로그 정리 (L, 락 대기와 별개) | 오늘 + 7일 일 파티션 생성, 재실행 무변화, 보관 기간 지난 파티션의 월 테이블 이동(중단 후 이어서 포함), 12개월 지난 월 테이블 삭제, p_max 경고, 보관 0일·0개월·32일 거부(1001), job_state 기록, 정체 감시 |
| 시즌 백업 분리 (B) | SETTLED 시즌 분리(submit_key 바로, entry는 다음 시즌 SETTLED·마지막 시즌), 재실행 무변화, 백업 COMMENT, 보관 기간 지난 백업 경고 대상(0일 제외), job_state 기록 |
| 관리 API (G) | 첫 admin CLI, 로그인·쿠키 속성, 초기 비밀번호 변경 강제, 비밀번호 규칙·변경과 세션 종료, 역할(operator 2003), 계정 생성·중복·수정·사용중지·초기화·잠금 해제, 연속·동시 실패 잠금, 잠금 중 비밀번호 대입 차단, Origin 검사, 유휴·최대 수명 만료, SP 역할 재확인(1405), 감사 로그와 비밀번호 마스킹 |
| 장애 주입 (X) | 요청 형식·권한·상태 거부 17종(코드·HTTP 상태, 바디 타입 변환 없음), 조회·보상 API 검증 9종, 빈도 초과, 같은 requestId 동시 제출, 같은 멤버 동시 첫 제출, 락 대기로 2005 뒤 커밋·재시도, API 경유 락 대기 초과(50001·롤백), 제출 경로 데드락(50001·롤백), Redis·로그 DB가 죽은 API(제출 성공·조회 2007·이력 실패 경고)와 워커(정산 건너뜀·로그 정리 실패), TCP 프록시로 만든 실행 중 Redis 무응답·다운과 로그 DB·메인 DB 다운 → 복구(메인 DB 다운 중 50001, DB 상태 로그 한 쌍), 메인 DB 무응답 중 동시 제출(대기열 초과 즉시 50001, 호출 제한 시간에 커넥션 회수, 재개 뒤 즉시 정상), 제출 처리 중 API 강제 종료, 메인 DB 접속 불가·잘못된 설정·포트 충돌 시 기동 거부, 키 폐기 전파(30초), 실행 중 migrate 거부, 가순위·확정 도중 워커 강제 종료(2대 동시 포함) 후 이어받기 |

---

# 5. 실행 확인

| 항목 | 확인 방법 |
|---|---|
| DB 연결·스키마 | 기동 로그에 `heartbeat started: <ID> ...`가 남고 프로세스가 종료되지 않는다 |
| 미적용 DB | `<SP 이름>이(가) DB에 없습니다. npm run migrate가 필요합니다.`로 기동이 거부된다 |
| 로그 DB | 접속되면 메인과 같이 확인된다. 접속할 수 없으면 `log DB(podium_de_log) unreachable ...` 경고만 남고 기동은 계속된다. 계정·DB 이름이 틀리면 `로그 DB(...) 접속 설정이 잘못되었습니다`로 기동이 거부된다 |
| API 헬스체크 | `curl http://localhost:3000/health` → `{"result":0}` |
