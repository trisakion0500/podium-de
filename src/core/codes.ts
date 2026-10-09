/**
 * DB 코드 컬럼(TINYINT UNSIGNED) 값 정의. ENUM 대신 숫자로 저장하고 의미는 여기서만 관리한다 (D-46).
 * SP는 같은 숫자를 리터럴로 쓰며, 값을 바꾸거나 추가하면 해당 테이블 컬럼 COMMENT와 01_DESIGN DDL도 함께 고친다.
 * 이미 저장된 값의 의미는 바꾸지 않는다 — 새 의미는 새 번호로 추가한다.
 */

/**
 * 랭킹 상태 (ranking_definition.status)
 * @author trisakion
 * @modified 2026-10-04 trisakion 테이블명 변경 반영 (D-50)
 */
export const RankingStatus = {
    /** 운영 중. 제출을 받는다 */
    ACTIVE: 1,
    /** 일시 중지. 제출을 거부한다 */
    PAUSED: 2,
    /** 종료. 제출을 거부한다 */
    ENDED: 3,
} as const;

/**
 * 갱신 규칙 (ranking_definition.update_rule, 01_DESIGN 2.3). 등록 후 불변
 * @author trisakion
 * @modified 2026-10-04 trisakion 테이블명 변경 반영 (D-50)
 */
export const UpdateRule = {
    /** 최고 기록. score = GREATEST(score, 입력) */
    BEST: 1,
    /** 부호 있는 증분 누적. score = GREATEST(score + 입력, 0), 멱등 키 필수 */
    SUM: 2,
    /** 소스 시퀀스가 클 때만 덮어씀. 2차 범위라 등록을 거부한다 */
    LATEST: 3,
} as const;

/**
 * 정렬 방향 (ranking_definition.sort_order). 등록 후 불변
 * @author trisakion
 * @modified 2026-10-04 trisakion 테이블명 변경 반영 (D-50)
 */
export const SortOrder = {
    /** 큰 값이 위 */
    DESC: 1,
    /** 작은 값이 위 (타임어택 등) */
    ASC: 2,
} as const;

/**
 * 동점 처리 시간 단위 (ranking_definition.time_unit, 01_DESIGN 2.4). 등록 후 불변
 * @author trisakion
 * @modified 2026-10-04 trisakion 테이블명 변경 반영 (D-50)
 */
export const TimeUnit = {
    /** 밀리초 */
    MS: 1,
    /** 초 */
    SEC: 2,
    /** 분 */
    MIN: 3,
    /** 일 */
    DAY: 4,
} as const;

/**
 * 시즌 주기 (ranking_definition.cycle_type, 01_DESIGN 2.5, D-45)
 * @author trisakion
 * @modified 2026-10-04 trisakion 테이블명 변경 반영 (D-50)
 */
export const CycleType = {
    /** 반복 없음. end_at이 있으면 단일 시즌 이벤트, 없으면 영구 랭킹 */
    NONE: 0,
    /** timezone 기준 하루 경계 */
    DAILY: 1,
    /** timezone 기준 한 주 경계 */
    WEEKLY: 2,
    /** timezone 기준 한 달 경계 */
    MONTHLY: 3,
    /** start_at부터 cycle_value초 고정 길이 */
    FIXED: 4,
} as const;

/**
 * 보상 구간 기준 (ranking_reward_tier.range_type, 01_DESIGN 2.6)
 * @author trisakion
 */
export const RangeType = {
    /** 순위 구간 */
    RANK: 1,
    /** 제재 제외 참가자 수 대비 백분율 구간 */
    PERCENT: 2,
} as const;

/**
 * 시즌 상태 (ranking_season.status, 01_DESIGN 3.5). 진행 순서대로 번호를 매겨 크기 비교로 단계를 판단할 수 있다
 * @author trisakion
 * @modified 2026-10-03 trisakion SETTLING 설명을 결과 통합에 맞춤 (D-49)
 * @modified 2026-10-08 trisakion FINALIZING 설명의 hall을 ranking_season_top으로 (D-59)
 */
export const SeasonStatus = {
    /** 시작 전 */
    SCHEDULED: 1,
    /** 스코어 적재 */
    OPEN: 2,
    /** 적재 차단 (실제 차단은 시각 검사) */
    CLOSED: 3,
    /** entry 파티션을 작업 테이블로 꺼내 가순위 생성 후 되돌림 */
    SETTLING: 4,
    /** 검수. 제재 반영 가능, 지급 없음 */
    REVIEW: 5,
    /** 제재 제외, 순위 재부여, 보상 판정, 시즌 Top N 적재 (ranking_season_top) */
    FINALIZING: 6,
    /** 게임 서버가 보상 목록 수신 및 ack */
    DELIVERING: 7,
    /** 완료 */
    SETTLED: 8,
} as const;

/**
 * 보상 상태 (ranking_entry.reward_status, 01_DESIGN 7.4)
 * @author trisakion
 * @modified 2026-10-03 trisakion 대상 컬럼을 ranking_entry로 변경 (D-49)
 */
export const RewardStatus = {
    /** 미판정(진행 중) 또는 보상 구간 밖 */
    NONE: 0,
    /** 대상, 전달 전 */
    PENDING: 1,
    /** 게임 서버 ack 완료 */
    DELIVERED: 2,
    /** 대상이었으나 제재로 미지급 */
    REJECTED: 3,
} as const;

/**
 * DDL 실행 상태 (log_ddl_audit.status)
 * @author trisakion
 */
export const DdlAuditStatus = {
    /** 실행 중. 이 값으로 남아 있으면 실행 중 중단된 것이다 */
    RUNNING: 0,
    /** 성공 */
    SUCCEEDED: 1,
    /** 실패 (오류 정보 기록) */
    FAILED: 2,
} as const;

/**
 * 프로세스 유형 (instance_heartbeat.process_type)
 * @author trisakion
 */
export const ProcessType = {
    /** API 서버 */
    API: 1,
    /** 워커 (스케줄 잡) */
    WORKER: 2,
} as const;

/**
 * API 키 권한 비트 (api_credential.scopes, 01_DESIGN 10.1). 한 키에 여러 권한을 OR로 조합한다
 * @author trisakion
 */
export const ApiScope = {
    /** 스코어 제출 */
    WRITE: 1,
    /** 순위·결과 조회 */
    READ: 2,
    /** 보상 목록 수신과 ack */
    REWARD: 4,
} as const;

/**
 * 관리 SP의 파티션 대상 테이블 코드 (SP_PARTITION_EXCHANGE, SP_PARTITION_DROP의 code 파라미터, 01_DESIGN 11.2)
 * @author trisakion
 * @modified 2026-10-03 trisakion RESULT 제거 (D-49)
 */
export const PartitionTarget = {
    /** ranking_entry */
    ENTRY: 1,
    /** ranking_submit_key */
    SUBMIT_KEY: 2,
} as const;

/**
 * SP의 RESULT 코드 (개발 컨벤션 4.4). 50001(SP 내부 시스템 오류)은 db.ts의 callSp가 예외로 바꾼다.
 * SP는 같은 숫자를 리터럴로 쓴다. API 응답 result로 그대로 나가며, API 계층 코드(ApiResult 20xx)와 겹치지 않게
 * 1000번대를 쓴다(1000번대 관리, 1100번대 제출, 1200번대 API 키, 1300번대 조회). 도메인당 99개, 넘치면 예비 대역을 준다.
 * @author trisakion
 * @modified 2026-10-04 trisakion 제출 SP 코드(1101~1107) 추가
 * @modified 2026-10-06 trisakion API 키 SP 코드(1201~1202) 추가
 * @modified 2026-10-06 trisakion API 계층 코드와 한 번호 공간으로 정리
 * @modified 2026-10-07 trisakion 조회 SP 코드(1301) 추가
 */
export const SpResult = {
    /** 성공 */
    OK: 0,
    /** 파라미터 형식 오류 (0, NULL, 허용 범위 밖) */
    INVALID_PARAM: 1001,
    /** ranking_season에 시즌 행이 없음 */
    SEASON_NOT_FOUND: 1002,
    /** 시즌 상태가 이 작업의 전제와 다름 (예: SETTLED가 아닌 시즌의 분리) */
    SEASON_STATUS_INVALID: 1003,
    /** ranking_entry 분리 조건 미충족: 다음 시즌이 SETTLED가 아님, 또는 마지막 시즌이 아닌데 다음 시즌 행이 없음 (D-52) */
    NEXT_SEASON_NOT_SETTLED: 1004,
    /** 운영 테이블에 시즌 파티션이 없음 (SETTLING인데 파티션 없음) */
    PARTITION_NOT_FOUND: 1005,
    /** 삭제하려는 파티션에 행이 있음 (먼저 백업으로 분리해야 함) */
    PARTITION_NOT_EMPTY: 1006,
    /** ranking_entry_settling에 다른 시즌 행이 있음 — 사람이 확인해야 함 */
    SETTLING_OCCUPIED: 1007,
    /** 되돌리기 직전 entry 시즌 파티션에 행이 있음 (꺼낸 뒤 쓰기 발생) — 사람이 확인해야 함 */
    SETTLING_CONFLICT: 1008,
    /** 제출: ranking_definition에 랭킹이 없음 */
    RANKING_NOT_FOUND: 1101,
    /** 제출: 랭킹이 ACTIVE가 아님 (D-34) */
    RANKING_INACTIVE: 1102,
    /** 제출: 시즌 행이 없거나 지금 시각이 그 시즌의 [start_at, end_at) 밖 (D-30) */
    SEASON_MISMATCH: 1103,
    /** 제출: 같은 requestId에 다른 내용(member, 값) (D-33) */
    IDEMPOTENCY_CONFLICT: 1104,
    /** 제출 하드 검증: BEST 값이 0 미만이거나 score_max 초과 (rejected 'SCORE_RANGE') */
    SCORE_OUT_OF_RANGE: 1105,
    /** 제출 하드 검증: SUM 증분의 절댓값이 max_delta 초과 (rejected 'MAX_DELTA') */
    DELTA_EXCEEDED: 1106,
    /** 제출 하드 검증: SUM 결과가 score_max 초과 (rejected 'SCORE_MAX', D-31) */
    SCORE_MAX_EXCEEDED: 1107,
    /** API 키: api_credential에 키가 없음 */
    CREDENTIAL_NOT_FOUND: 1201,
    /** API 키: 이미 폐기된 키 */
    CREDENTIAL_ALREADY_REVOKED: 1202,
    /** 조회: 지금 시각이 [start_at, end_at)에 드는 시즌 행이 없음 (시즌 사이 공백, 종료된 랭킹) */
    CURRENT_SEASON_NOT_FOUND: 1301,
} as const;

/**
 * API 계층 결과 코드. SpResult와 한 번호 공간을 쓴다 — SP 코드는 변환 없이 API 응답 result와
 * log_ranking_submit.result_code로 그대로 나가므로, 대역만 보고 발생 위치를 안다(10xx~12xx SP, 20xx API 계층,
 * 5000 앱 미분류, 50001 DB 시스템 오류). 메시지와 HTTP 상태는 errors.ts의 ERROR_MAP에서만 관리한다.
 * @author trisakion
 * @modified 2026-10-07 trisakion 제출 빈도 초과(2006) 추가
 * @modified 2026-10-07 trisakion 순위 집계 중(2007) 추가
 */
export const ApiResult = {
    /** 요청 형식 오류 (스키마 검증 실패, JSON 파싱 실패 등) */
    VALIDATION_FAILED: 2001,
    /** API 키가 없거나 등록되지 않음 */
    UNAUTHORIZED: 2002,
    /** API 키에 이 요청의 권한 비트가 없음 */
    FORBIDDEN: 2003,
    /** 없는 경로 */
    NOT_FOUND: 2004,
    /** 처리 시간 초과. 작업은 서버에서 계속되어 반영될 수 있다 (개발 컨벤션 7.2) */
    TIMEOUT: 2005,
    /** 제출 빈도 초과 (max_submit_per_min, Redis 카운터). SP를 거치지 않아 멱등 키가 없으므로 같은 requestId로 재시도한다 */
    TOO_MANY_REQUESTS: 2006,
    /** 순위 조회 불가: 센티넬 없음(준비 전 — 워커 정지·시즌 행 지연, 재구축 중, 01_DESIGN 5.3·6.3) 또는 Redis 연결 끊김·시간 초과. 잠시 후 재시도한다 */
    RANKING_UNAVAILABLE: 2007,
    /** 분류되지 않은 앱 예외 */
    INTERNAL_ERROR: 5000,
    /** SP 내부 시스템 오류 (SP RESULT 50001, db.ts callSp가 던짐) */
    DATABASE_ERROR: 50001,
} as const;

/**
 * SP_SETTLING_EXCHANGE가 돌려주는 settling 단계 (01_DESIGN 7.3, 8.6)
 * @author trisakion
 */
export const SettlingState = {
    /** 시즌 데이터가 ranking_entry_settling에 있고 정렬 인덱스가 준비됨. 가순위 UPDATE를 이어서 한 뒤 다시 호출한다 */
    OUT: 1,
    /** 시즌 데이터가 ranking_entry 파티션으로 돌아옴. Redis 키 삭제와 REVIEW 전이로 넘어간다 */
    RETURNED: 2,
} as const;
