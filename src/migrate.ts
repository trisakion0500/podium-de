import { config } from './core/config.js';
import { createPool } from './core/db.js';
import { logger, shutdownLogger } from './core/logger.js';
import { runMigrations } from './core/migration.js';

// `npm run migrate`: 마이그레이션을 적용하고 종료한다.
const pool = createPool('MIGRATE');
try {
    const done = await runMigrations(pool);
    logger.info(done.length ? `migrations done: ${done.length} applied (app ${config.appVersion})` : 'no pending migrations');
} catch (err) {
    logger.error('migration failed', err);
    process.exitCode = 1;
} finally {
    await pool.end();
    await shutdownLogger();
}
