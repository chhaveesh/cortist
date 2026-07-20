import request from 'supertest';
import { CalendarConfigService } from '../../src/config/calendar-config.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import {
  TestHarness,
  createHarness,
  destroyHarness,
  resetState,
} from '../harness';

describe('GET /health (integration)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await destroyHarness(harness);
  });

  beforeEach(async () => {
    await resetState(harness);
    jest.restoreAllMocks();
  });

  const get = () => request(harness.app.getHttpServer()).get('/health');

  it('returns 200 and reports both dependencies connected', async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      redis: 'connected',
      postgres: 'connected',
      // .env.test supplies the full calendar credential set.
      calendar: 'configured',
    });
  });

  /**
   * An unconfigured calendar is a setup state, not an outage. Reporting it is
   * useful; returning 503 for it would pull a gateway that is happily accepting
   * and queueing messages out of load-balancer rotation.
   */
  it('reports calendar configuration without affecting the status code', async () => {
    const calendarConfig = harness.app.get(CalendarConfigService);
    jest.spyOn(calendarConfig, 'isConfigured', 'get').mockReturnValue(false);
    jest
      .spyOn(calendarConfig, 'missingVars', 'get')
      .mockReturnValue(['ANTHROPIC_API_KEY']);

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.calendar).toBe('not_configured');
    expect(response.body.calendarMissing).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('actually probes the dependencies rather than returning a static 200', async () => {
    const prisma = harness.app.get(PrismaService);
    const querySpy = jest.spyOn(prisma, '$queryRaw');
    const redis = harness.app.get<{ ping: () => Promise<string> }>(
      REDIS_CLIENT,
    );
    const pingSpy = jest.spyOn(redis, 'ping');

    await get().expect(200);

    expect(querySpy).toHaveBeenCalled();
    expect(pingSpy).toHaveBeenCalled();
  });

  /**
   * Simulating a real outage would mean stopping a container mid-suite, which
   * would break every other test sharing it. Forcing the probe to reject
   * exercises the same branch the controller takes when the dependency is
   * genuinely unreachable.
   */
  it('returns 503 and names the failure when Redis is unreachable', async () => {
    const redis = harness.app.get<{ ping: () => Promise<string> }>(
      REDIS_CLIENT,
    );
    jest
      .spyOn(redis, 'ping')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const response = await get();

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('error');
    expect(response.body.redis).toBe('disconnected');
    expect(response.body.postgres).toBe('connected');
    expect(response.body.failures).toEqual([
      { dependency: 'redis', error: expect.stringContaining('ECONNREFUSED') },
    ]);
  });

  it('returns 503 and names the failure when Postgres is unreachable', async () => {
    const prisma = harness.app.get(PrismaService);
    jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('the database system is starting up'));

    const response = await get();

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('error');
    expect(response.body.postgres).toBe('disconnected');
    expect(response.body.redis).toBe('connected');
    expect(response.body.failures).toEqual([
      { dependency: 'postgres', error: expect.stringContaining('starting up') },
    ]);
  });

  it('reports both failures when everything is down', async () => {
    const prisma = harness.app.get(PrismaService);
    const redis = harness.app.get<{ ping: () => Promise<string> }>(
      REDIS_CLIENT,
    );
    jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('pg down'));
    jest.spyOn(redis, 'ping').mockRejectedValueOnce(new Error('redis down'));

    const response = await get();

    expect(response.status).toBe(503);
    expect(response.body.failures).toHaveLength(2);
  });
});
