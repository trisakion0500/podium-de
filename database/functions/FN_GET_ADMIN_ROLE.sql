DROP FUNCTION IF EXISTS `FN_GET_ADMIN_ROLE`;
DELIMITER $$
CREATE FUNCTION `FN_GET_ADMIN_ROLE` (
    i_admin_account_id    INT UNSIGNED    -- 요청자 GM 계정 ID (0:SYSTEM 관리 CLI)
) RETURNS TINYINT UNSIGNED READS SQL DATA COMMENT '요청자 GM 역할 (0:없음·사용중지, 1:VIEWER, 2:OPERATOR, 3:ADMIN)'
BEGIN
    -- ------------------------------------------------------------------------------------------------------------ --
    -- 명칭 : FN_GET_ADMIN_ROLE
    -- 작성 : 2026.10.22 trisakion
    -- 내용 : 상태를 바꾸는 관리 SP가 요청자 역할을 다시 확인할 때 쓴다 (01_DESIGN 10.4, D-74, 개발 컨벤션 4.2).
    --        앱이 이미 확인했더라도 앱 버그나 우회 호출에 DB가 마지막 방어선이 되게 한다. 역할 값은 앱에서 받지 않는다.
    --        - 0은 관리 CLI(SYSTEM, 개발 컨벤션 5.3)라 ADMIN으로 본다. 세션 ID는 AUTO_INCREMENT라 1부터이므로
    --          관리 API 경로는 0을 넘길 수 없다.
    --        - 없는 계정과 사용중지(status 2) 계정은 0이다. 비교하는 쪽이 "역할 ≥ 필요 역할"만 보면 모두 거부된다.
    --        - 알 수 없는 역할 값은 가장 낮은 VIEWER로 본다(D-74). 코드에 없는 값이 더 큰 권한이 되지 않게 한다.
    --        - 일관된 읽기(잠그지 않음)라 잠금 순서 대상이 아니다.
    -- ------------------------------------------------------------------------------------------------------------ --
    DECLARE v_role      TINYINT UNSIGNED DEFAULT NULL;
    DECLARE v_status    TINYINT UNSIGNED DEFAULT NULL;

    IF i_admin_account_id IS NULL THEN
        RETURN 0;
    END IF;
    IF i_admin_account_id = 0 THEN
        RETURN 3;
    END IF;

    SELECT role, status INTO v_role, v_status
      FROM admin_account
     WHERE admin_account_id = i_admin_account_id;

    IF v_status IS NULL OR v_status <> 1 THEN
        RETURN 0;
    END IF;
    IF v_role NOT IN (1, 2, 3) THEN
        RETURN 1;
    END IF;
    RETURN v_role;
END$$
DELIMITER ;
