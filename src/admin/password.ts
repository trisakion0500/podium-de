import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * scrypt 파라미터 (01_DESIGN 10.4). OWASP 권장 조합 중 N=2^14, r=8, p=5 — 메모리 16MB(128 × N × r)로
 * Node 기본 maxmem(32MB) 안에 들고, 동시 로그인이 몰려도 메모리가 크게 늘지 않는다. p가 계산 시간을 늘린다.
 */
const PARAMS = { N: 16384, r: 8, p: 5 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** 비밀번호 길이 (01_DESIGN 10.4). 상한은 아주 긴 입력으로 해시 비용을 키우는 공격을 막는다 */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

/**
 * scrypt를 Promise로 부른다. 동기 버전은 해시 동안 이벤트 루프를 막아 다른 요청까지 늦춘다.
 * @param password 비밀번호
 * @param salt 솔트
 * @param options N, r, p
 * @returns 32바이트 키
 */
function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
    return new Promise((ok, fail) => scrypt(password, salt, KEY_BYTES, options, (err, key) => (err ? fail(err) : ok(key))));
}

/**
 * 비밀번호를 해시한다. 형식은 `scrypt$N$r$p$솔트$해시`(base64url)다. 파라미터를 함께 저장해 나중에 올려도 기존 해시를 검증한다.
 * @param password 비밀번호 원문
 * @returns 저장할 해시 문자열
 * @author trisakion
 */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(password, salt, PARAMS);
    return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * 저장된 해시와 비교한다. 비교는 timingSafeEqual이라 일치하는 앞부분 길이가 응답 시간에 드러나지 않는다.
 * 형식이 틀린 해시는 false다(예외 없음) — 로그인 경로가 한 갈래로 "틀림"이 되게 한다.
 * @param password 입력한 비밀번호
 * @param stored 저장된 해시 문자열
 * @returns 일치 여부
 * @author trisakion
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !hash)
        return false;
    const expected = Buffer.from(hash, 'base64url');
    const key = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
    return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 없는 아이디로 로그인할 때 비교할 해시. 있는 아이디와 응답 시간을 맞춰 아이디 존재를 드러내지 않는다 */
let dummyHash: Promise<string> | undefined;

/**
 * 없는 아이디의 로그인에서 같은 비용으로 비교를 한 번 한다. 결과는 항상 false다.
 * @param password 입력한 비밀번호
 * @returns false
 * @author trisakion
 */
export async function verifyDummy(password: string): Promise<false> {
    dummyHash ??= hashPassword(randomBytes(16).toString('base64url'));
    await verifyPassword(password, await dummyHash);
    return false;
}

/**
 * 비밀번호 규칙을 확인한다 (01_DESIGN 10.4). 문자 조합 규칙은 두지 않는다 — 길이가 더 효과적이다(NIST SP 800-63B).
 * @param password 새 비밀번호
 * @param loginId 그 계정의 아이디 (같으면 거부, 대소문자 무시)
 * @returns 통과 여부
 * @author trisakion
 */
export function passwordAllowed(password: string, loginId: string): boolean {
    const length = [...password].length;
    return length >= PASSWORD_MIN && length <= PASSWORD_MAX && password.toLowerCase() !== loginId.toLowerCase();
}

/**
 * 초기 비밀번호를 만든다. 12바이트 난수(base64url 16자)라 규칙(12자 이상)을 만족하고, 사람이 전달하기에 짧다.
 * @returns 초기 비밀번호 원문 (응답·CLI 출력에 한 번만 담는다)
 * @author trisakion
 */
export function generatePassword(): string {
    return randomBytes(12).toString('base64url');
}
