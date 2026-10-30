# 운영·배포

설치본을 띄우고, 배포하고, 마이그레이션하는 방법이다. 왜 이렇게 했는지는 [01_DESIGN 11.3\~11.6](01_DESIGN.md#s-11-3), 로컬 개발 환경은 [03_DEV_SETUP](03_DEV_SETUP.md)을 본다.

## 1. 프로세스

운영 중 계속 떠 있어야 하는 것은 이 세 가지다.

| 명령 | 프로세스 | 역할 | 권장 대수 |
|---|---|---|---|
| `npm run start:api` | API | 게임 서버의 S2S 요청(제출, 순위 조회) | 2 (목표 피크 460건/초 기준 N+1, [07_K6_LOAD_TEST 1.2](07_K6_LOAD_TEST.md)) |
| `npm run start:worker` | 워커 | 스케줄러, 리컨실러, 정산, 보상 전달, 아카이브 | 2 (장애 대비, 아래 배포 절 참고) |
| `npm run start:admin` | 관리 API | GM 계정·세션 쿠키 인증 관리 기능 | 1 |

MySQL 메인, MySQL 로그 DB, Redis는 이 저장소 밖에서 따로 운영하는 인프라다.

API·워커·관리 API는 기동 시 하트비트를 기록한 뒤
migrate와 같은 락을 잡고 DB 스키마가 패키지와 같은지 확인만 하며, 다르면 하트비트를 지우고 기동하지 않는다.
적용은 `npm run migrate`로만 한다.

API와 워커 대수는 따로 정한다. API는 처리량에 맞춰 늘린다. 워커는 잡마다 한 곳에서만 돌아
늘려도 빨라지지 않으므로 장애 대비로 2대를 둔다. 한 대가 죽으면 다른 워커가 다음 차례에 락을
잡고 이어서 돌린다([01_DESIGN 11.3](01_DESIGN.md#s-11-3)). 인스턴스마다 커넥션
풀(`DB_POOL_SIZE`)을 따로 가지므로, (API 수 + 워커 수 + 관리 API 수) × `DB_POOL_SIZE`가 MySQL
`max_connections`를 넘지 않게 한다.

필요할 때 실행하는 명령 — 실행하고 끝나는 명령이며, 상시 프로세스가 아니다.

| 명령 | 설명 |
|---|---|
| `npm run build` | TypeScript 컴파일(`dist/`) |
| `npm run migrate` | 대기 중인 테이블·SP 마이그레이션 적용 |
| `npm run upgrade` | 중단 패치 일괄 실행(중지 → migrate → 기동 → 새 버전 확인) |
| `npm run credential` | API 키 발급·폐기·목록 (`create <이름> write,read,reward` / `revoke <ID>` / `list [--all]`). migrate 계정 사용, 키는 발급 때 한 번만 표시 |
| `npm run admin` | 관리 계정 CLI (`create --login-id <아이디> --name <이름>` / `reset-password --login-id <아이디>`). migrate 계정 사용, 초기 비밀번호는 한 번만 표시 |

## 2. 배포

| 배포 유형 | 조건 | 방식 |
|---|---|---|
| 중단 패치 | DB 변경(테이블, SP) 있음 | 전체 프로세스 중지 → 마이그레이션 → 기동. 게임 점검 시간에 맞춘다 |
| 롤링 | DB 변경 없음 | 인스턴스를 하나씩 교체 |

> **DB 변경이 있는 패키지는 `pm2 reload`(롤링) 금지, `npm run upgrade`만 사용한다.**
> 새 인스턴스가 스키마 불일치로 기동을 거부해도 pm2는 `--listen-timeout`이 지나면 구버전을
> 내리고, 모든 인스턴스가 errored가 되어 전체가 중단된다(아래 실험 결과).

롤링 절차 (DB 변경 없음): 새 패키지 설치 후 `npm run build` → `pm2 reload podium-api podium-worker`.
API·워커는 기동 확인(하트비트 기록, 스키마 확인)을 통과한 뒤(API는 listen 성공 후) pm2에 `ready`를
보내고, pm2는 `--wait-ready`로 이를 기다린 뒤 구버전을 내린다. 로드밸런서 헬스체크는 `GET /health`를
쓴다(기동 확인을 통과해 떠 있으면 200).

| 실험 (pm2 7.0.4, 새 패키지가 기동 확인 실패로 종료) | 결과 |
|---|---|
| API 클러스터 `-i 2 --wait-ready --listen-timeout 15000` | 구버전은 인스턴스마다 `listen-timeout` 동안만 유지되고, 그 뒤 내려간다. reload 시작 약 32초 후 전체 중단, 두 인스턴스 모두 errored |
| 워커 fork 모드 | reload가 재시작으로 동작해 구버전이 바로 내려간다 |

실수로 reload했다면 이전 패키지로 되돌려 `pm2 reload`하거나, 새 패키지로 `npm run upgrade`를 실행한다.

## 3. 중단 패치 (`npm run upgrade`)

1. 새 패키지 설치 후 `npm run build`
2. `npm run upgrade` — 아래 단계를 차례로 실행하고, 각 단계 결과와 명령 출력·종료 코드를 출력한다.
   하나라도 실패하면 거기서 멈추고 종료 코드 1로 끝난다.

| 단계 | 동작 | 실패 조건 |
|---|---|---|
| 1 stop | `UPGRADE_STOP_CMD` 실행 | 종료 코드 ≠ 0 |
| 2 wait stop | 살아 있는 인스턴스가 없어질 때까지 대기 | `UPGRADE_TIMEOUT_SEC` 초과 — 남은 인스턴스 출력 |
| 3 migrate | `npm run migrate`와 같은 규칙(하트비트·버전 검사 포함) | migrate 거부·실패 |
| 4 start | `UPGRADE_START_CMD` 실행 | 종료 코드 ≠ 0 |
| 5 wait start | 새 `version`의 하트비트가 API `UPGRADE_EXPECT_API`개, 워커 `UPGRADE_EXPECT_WORKER`개, 관리 API `UPGRADE_EXPECT_ADMIN`개(기본 0) 이상 | `UPGRADE_TIMEOUT_SEC` 초과 — 현재 인스턴스 출력 |

`UPGRADE_STOP_CMD`, `UPGRADE_START_CMD`가 없으면 1단계 전에 중단한다(아무것도 멈추지 않음).
명령 실행·중지 대기·기동 대기는 각각 `UPGRADE_TIMEOUT_SEC`(기본 120초)를 넘으면 실패다.
4·5단계에서 실패하면 마이그레이션은 이미 적용된 상태이므로, 원인을 고친 뒤 기동만 다시 한다.

### 설정 예시 (`.env`)

pm2 — 최초 1회 등록한다. `--kill-timeout`은 정상 종료(진행 중 요청 마무리, 하트비트 삭제)를
기다릴 시간이다. 기본값(1.6초)을 넘기면 강제 종료되어 하트비트가 30초 동안 남고, 2단계가 그만큼 기다린다.
`--wait-ready`는 롤링 시 기동 확인 통과를 기다리게 하고, `--listen-timeout`은 그 대기 한도다.
기동 확인이 migrate 락을 최대 10초 기다리므로 그보다 길게 잡는다.

```bash
pm2 start dist/api.js --name podium-api -i 2 --wait-ready --listen-timeout 20000 --kill-timeout 10000
pm2 start dist/worker.js --name podium-worker -i 2 --wait-ready --listen-timeout 20000 --kill-timeout 10000
```

```dotenv
UPGRADE_STOP_CMD=pm2 stop podium-api podium-worker
UPGRADE_START_CMD=pm2 start podium-api podium-worker
UPGRADE_EXPECT_API=2
UPGRADE_EXPECT_WORKER=2
```

직접 실행 (Linux) — 시작 명령은 백그라운드로 띄우고 출력을 파일로 돌린다. 중지 명령은
SIGTERM으로 정상 종료시키며, 대상이 없을 때도 실패하지 않도록 `|| true`를 붙인다.

```dotenv
UPGRADE_STOP_CMD=pkill -TERM -f "node dist/(api|worker)\.js" || true
UPGRADE_START_CMD=mkdir -p logs && (nohup node dist/api.js >> logs/api.out 2>&1 &) && (nohup node dist/worker.js >> logs/worker.out 2>&1 &)
UPGRADE_EXPECT_API=1
UPGRADE_EXPECT_WORKER=1
```

upgrade 없이 수동으로 할 때는 전체 프로세스 중지 → `npm run migrate` → API·워커 기동 순서로 한다.

## 4. 하트비트와 migrate 거부

API·워커·관리 API는 실행 중 10초마다 `instance_heartbeat`에 하트비트를 남기고, 정상 종료 시 자기 행을
지운다. 인스턴스 ID는 기동마다 새로 만드는 UUID이고, 마지막 하트비트에서 1시간이 지난 행은
하트비트 기록 때 함께 지워진다. `migrate`는 최근 30초 안에 하트비트가 있으면 거부하고 살아 있는
인스턴스 목록(유형, 인스턴스 ID, 버전, 마지막 하트비트 시각)을 출력한다. 강제 실행 옵션은 없다.

migrate가 하트비트로 거부되면

1. 출력된 인스턴스 ID로 로그의 `heartbeat started: <ID> (host ..., pid ...)` 줄을 찾아
   남은 프로세스를 중지한다(정상 종료하면 행이 바로 지워진다).
   `UPGRADE_STOP_CMD`가 그 인스턴스를 멈추지 못한 것이므로 명령도 함께 고친다.
2. 프로세스가 이미 없는데 목록에 남아 있으면 비정상 종료한 인스턴스다. 마지막 하트비트에서
   30초가 지나면 목록에서 빠지므로 기다린 뒤 다시 실행한다.
3. `npm run upgrade`(또는 `npm run migrate`) 재실행

결과적으로 "중지 없이 migrate"는 하트비트 검사로, "migrate 없이 기동"은 스키마 확인으로 막힌다.
기동과 migrate는 같은 락 안에서 확인하고 기동은 락보다 하트비트를 먼저 기록하므로, migrate 도중에
구버전 패키지를 기동해도 락을 기다렸다가 새 스키마와 달라 거부된다.

## 5. 마이그레이션 규칙

- 테이블: `database/tables`의 버전 파일. 파일 하나에 DDL 구문 하나만 두며, 적용된 파일은 수정하지 않고 새 버전 파일을 추가한다.
- Function: `database/functions`의 파일. SP와 같은 규칙이며 SP보다 먼저 적용된다. binlog가 켜진 MySQL은 `log_bin_trust_function_creators = 1`이 필요하다([D-80](02_DECISIONS.md#d-80)).
- SP: `database/procedures`의 파일. 내용이 바뀌면 다시 적용된다(DROP 후 CREATE). 삭제는 `DROP` 구문만 남긴 파일로 한다.
- 로그 DB는 `database_log/`에 같은 규칙으로 둔다. `migrate`가 메인 다음에 적용한다. 기동 시 로그 DB에 접속할 수 없으면 경고만 남기고 기동하며, 접속되는데 스키마가 다르면 거부한다.
- DB 변경이 있는 배포는 `package.json`의 `version`을 올린다. DB에 기록된 버전보다 낮은 패키지로는 `migrate`가 거부된다.
  DB에 적용된 테이블 파일이 패키지에 없어도 거부된다. SP만 바뀐 롤백은 버전 비교로만 막히므로 버전을 올리지 않으면 막지 못한다.
