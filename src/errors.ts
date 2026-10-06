import { ApiResult } from './codes.js';

/**
 * 결과 코드 하나의 응답 메시지와 HTTP 상태.
 * @author trisakion
 */
export interface ErrorEntry {
    /** 응답 message (게임 서버 개발자가 읽는다) */
    message: string;
    /** HTTP 상태 코드 */
    httpStatus: number;
}

/**
 * API로 나가는 실패 결과 코드의 메시지와 HTTP 상태 (개발 컨벤션 9). 코드·메시지·상태는 이 표에서만 관리한다.
 * HTTP 상태는 대역 규칙을 따른다: 형식 400, 인증 401, 권한 403, 없음 404, 시간 초과 503, 시스템 500.
 * SP 코드(SpResult)는 그 SP를 쓰는 API를 만들 때 여기에 추가한다 — 표에 없는 코드는 BusinessException으로 던질 수 없다.
 * @author trisakion
 */
export const ERROR_MAP = {
    [ApiResult.VALIDATION_FAILED]: { message: '요청 형식이 올바르지 않습니다.', httpStatus: 400 },
    [ApiResult.UNAUTHORIZED]: { message: 'API 키가 없거나 유효하지 않습니다.', httpStatus: 401 },
    [ApiResult.FORBIDDEN]: { message: '이 API를 호출할 권한이 없습니다.', httpStatus: 403 },
    [ApiResult.NOT_FOUND]: { message: '존재하지 않는 경로입니다.', httpStatus: 404 },
    [ApiResult.TIMEOUT]: { message: '처리 시간이 초과되었습니다. 쓰기 요청은 반영되었을 수 있습니다.', httpStatus: 503 },
    [ApiResult.INTERNAL_ERROR]: { message: '서버 내부 오류입니다.', httpStatus: 500 },
    [ApiResult.DATABASE_ERROR]: { message: '데이터베이스 오류입니다.', httpStatus: 500 },
} satisfies Record<number, ErrorEntry>;

/**
 * ERROR_MAP에 정의된 결과 코드.
 * @author trisakion
 */
export type ErrorCode = keyof typeof ERROR_MAP;

/**
 * 예측 가능한 실패를 던지는 단일 예외 (개발 컨벤션 9). 결과 코드만 넘기면 응답 메시지와 HTTP 상태는 ERROR_MAP에서 채운다.
 * Error.message는 로그용 상세(detail)다 — 응답에는 절대 쓰지 않고 ERROR_MAP 메시지만 내보낸다.
 * @author trisakion
 */
export class BusinessException extends Error {
    /** HTTP 상태 (ERROR_MAP) */
    readonly httpStatus: number;
    /** 응답 message (ERROR_MAP) */
    readonly publicMessage: string;
    /** DB 오류 진단 SQLSTATE (DATABASE_ERROR일 때만, 응답에 넣지 않는다) */
    readonly sqlState?: string;
    /** DB 오류 진단 MySQL 오류 번호 (DATABASE_ERROR일 때만, 응답에 넣지 않는다) */
    readonly errorNo?: number;

    /**
     * @param result 결과 코드
     * @param detail 로그용 상세. 생략하면 ERROR_MAP 메시지
     * @param diag DB 오류 진단 정보. 재시도 가능 여부를 스스로 판단해야 하는 내부 호출부만 읽는다
     */
    constructor(readonly result: ErrorCode, detail?: string, diag?: { sqlState?: string; errorNo?: number }) {
        super(detail ?? ERROR_MAP[result].message);
        this.name = 'BusinessException';
        this.httpStatus = ERROR_MAP[result].httpStatus;
        this.publicMessage = ERROR_MAP[result].message;
        this.sqlState = diag?.sqlState;
        this.errorNo = diag?.errorNo;
    }
}
