-- ------------------------------------------------------------------------------------------------------------ --
-- 명칭 : job_state
-- 작성 : 2026.10.02 trisakion
-- 내용 : 워커 잡별 진행 상태 (01_DESIGN 11.4). 리컨실러 checkpoint(01_DESIGN 6.2) 등 워터마크와 마지막 실행 시각을 둔다.
--        리컨실러 워터마크는 정산 시작 조건(01_DESIGN 7.1)에서 시즌별로 비교하므로 키에 (ranking_id, season_no)를 둔다.
--        랭킹과 무관한 잡은 (0, 0)을 쓴다.
--        의도적 복합 PK (job_name, ranking_id, season_no): 잡 대상의 자연키다.
--        ranking_id, season_no는 FK 없음: (0, 0) sentinel이 있다.
-- ------------------------------------------------------------------------------------------------------------ --
CREATE TABLE `job_state` (
    `job_name`       VARCHAR(64)                NOT NULL                    COMMENT '잡 이름 (예: reconciler)',
    `ranking_id`     INT            UNSIGNED    NOT NULL                    COMMENT '대상 랭킹 ID (0:랭킹 무관, FK 없음)',
    `season_no`      INT            UNSIGNED    NOT NULL                    COMMENT '대상 시즌 번호 (0:시즌 무관, FK 없음)',
    `watermark`      DATETIME(3)                            DEFAULT NULL    COMMENT '처리 완료 워터마크 (UTC, 리컨실러는 updated_at checkpoint)',
    `last_run_at`    DATETIME(3)                            DEFAULT NULL    COMMENT '마지막 실행 시각 (UTC)',
    `updated_at`     DATETIME(3)                NOT NULL                    COMMENT '행 갱신 시각 (UTC)',
    PRIMARY KEY (`job_name`, `ranking_id`, `season_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='워커 잡별 진행 상태';
