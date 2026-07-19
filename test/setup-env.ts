import { config } from 'dotenv';
import { resolve } from 'node:path';
import { installNetworkGuard } from './network-guard';

/**
 * Loads .env.test BEFORE any module reads process.env, so the app under test
 * connects to the isolated containers rather than the developer's dev stack.
 *
 * `override: true` matters: a developer with a shell-exported DATABASE_URL
 * pointing at their dev database must not have tests silently truncate it.
 */
config({ path: resolve(__dirname, '..', '.env.test'), override: true });

// Fail loudly if anything tries to reach a real external host. Localhost stays
// open for Postgres and Redis. See test/network-guard.ts for why this exists.
installNetworkGuard();
