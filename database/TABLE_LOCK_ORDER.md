# 테이블 접근 순서 (메인 DB `podium_de`)

한 트랜잭션에서 여러 테이블을 잠그거나 갱신하는 SP는 이 순서를 따른다. 순서가 엇갈린 두 SP가 겹치면 데드락이 난다.
SP를 새로 만들거나 기존 SP에 테이블 쓰기를 추가할 때 먼저 이 표를 확인하고, 새 테이블은 이 표에 위치를 정해 추가한다.

| 순서 | 테이블 | 비고 |
| --- | --- | --- |
| 1 | `ranking_definition` | 설정. 데이터 경로는 읽기만 한다 |
| 2 | `ranking_reward_tier` | 설정 |
| 3 | `ranking_season` | 상태 전이는 조건부 UPDATE |
| 4 | `ranking_exclusion` | 제재 등록 |
| 5 | `ranking_suspicion` | 어뷰징 포인트 |
| 6 | `ranking_submit_key` | 제출: 멱등 키를 entry보다 먼저 기록해 같은 requestId 동시 요청을 키 충돌로 직렬화한다 |
| 7 | `ranking_entry` | 스코어와 정산 결과 |
| 8 | `ranking_entry_settling` | 정산 작업 테이블. 가순위 UPDATE만 쓴다 |
| 9 | `ranking_season_top` | FINALIZING 적재, 지급 후 제재 표시 |
| 10 | `job_state` | 잡 동기화 시각 |
| 11 | `instance_heartbeat` | 하트비트 (단독 자동 커밋) |
| 12 | `api_credential` | API 키 발급·폐기 (단독 자동 커밋) |
| 13 | `log_ddl_audit` | `SP_EXEC_DDL` 전용 (단독 자동 커밋) |

- 설정 → 상태 → 데이터 → 부가 기록 순이다. 상위(부모) 행을 먼저 잠그면 하위 행 갱신이 같은 순서로 줄을 선다.
- 잠그지 않는 일반 SELECT(일관된 읽기)는 순서의 대상이 아니다. `SELECT ... FOR UPDATE`, `FOR SHARE`, 쓰기만 해당한다.
- 트랜잭션 안에서 `SET v = (SELECT ...)`처럼 SELECT가 아닌 문장의 서브쿼리는 REPEATABLE READ에서 S 락으로 읽는다. 잠그지 않으려면 `SELECT ... INTO`를 쓴다 (`SP_SUBMIT_SCORE`에서 데드락으로 확인).
- DDL(파티션, 백업 테이블, settling 인덱스)은 암묵적으로 커밋되므로 트랜잭션 안에 두지 않는다. 관리 SP는 이 순서의 대상이 아니다.
- 백업 테이블(`{원본}_r{id}_s{n}`)은 데이터 경로가 접근하지 않는다.
