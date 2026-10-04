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
    /** 제재 제외, 순위 재부여, 보상 판정, hall 적재 */
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
