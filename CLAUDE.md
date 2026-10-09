# Podium DE

- 공통 코딩·SP·커밋 컨벤션: `.claude/skills/trisakion-dev-convention-skill/SKILL.md`
- 설계 기준: `docs/01_DESIGN.md` (용어는 1.6), 결정 기록: `docs/02_DECISIONS.md` (D-xx)
- 이 저장소는 `CLAUDE.md`를 커밋한다(공용 규칙만). 개인 설정은 `CLAUDE.local.md`(gitignore)에 둔다 — 컨벤션 스킬 12장의 예외.

## DB
- DB 변경은 `npm run migrate`로만 한다. 직접 SQL로 테이블·SP를 바꾸지 않는다.
- 이미 적용된 V 파일은 고치지 않는다(러너가 거부). 바꿀 게 있으면 새 V 파일을 추가한다. 파일 하나에 DDL 하나만 둔다.
- 테이블 DDL을 바꾸면 01_DESIGN의 설계 DDL도 같이 고친다.
- 여러 테이블을 잠그는 SP는 `database*/TABLE_LOCK_ORDER.md`의 순서를 따른다.

## 코드
- 로그는 log4js만 쓴다. `console.log`는 쓰지 않는다. 예외: CLI가 키 원문을 stdout으로 내보낼 때, 테스트·부하 스크립트(`tests/`, `loadtest/`)가 결과를 출력할 때.
- `src/core`는 루트 파일(엔트리·CLI)을 import하지 않는다.
- 회귀 테스트는 `tests/recovery.mjs`를 갱신한다(컨벤션 3장의 `api_test.ps1` 대신).

## 보안
- `.env`, 비밀번호, API 키 원문은 저장소·로그·명령줄에 남기지 않는다.
- 부하 테스트용 키 파일은 저장소 밖(`%TEMP%\podium-load.keys`)에 둔다.

## 문서
- 아직 구현하지 않은 기능은 "N단계 구현 예정"처럼 계획으로 적는다("지금은 안 된다"로 쓰지 않는다).
- 기능을 마치면 README의 "현재 상태" ✅/⬜를 같은 변경에서 함께 갱신한다.
- 보고서는 "그래서 어떻게 하라는 건가"에 답하는 결론과 핵심 수치를 맨 앞에 둔다.
