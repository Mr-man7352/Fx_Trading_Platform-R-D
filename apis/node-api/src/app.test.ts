import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const TOKEN = 'test-internal-token-16ch';

function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    TRADING_MODE: 'paper',
    INTERNAL_API_TOKEN: TOKEN,
    NEXTAUTH_SECRET: 'test-nextauth-secret-16ch',
    INTERNAL_SYNC_TOKEN: 'test-internal-sync-token-16ch',
    LOG_LEVEL: 'fatal',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://fx:fx@localhost:5432/fx',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  });
}

describe('Step 1.3 — Fastify shell (BE-010…015)', () => {
  let app: FastifyInstance;
  const auditedUrls: string[] = [];

  beforeAll(async () => {
    app = await buildApp(testEnv());
    // Test-only routes to exercise validation (BE-012) + audit (BE-013).
    app.withTypeProvider<ZodTypeProvider>().route({
      method: 'POST',
      url: '/v1/test/echo',
      schema: {
        body: z.object({ name: z.string().min(1), count: z.number().int() }),
        response: { 200: z.object({ name: z.string(), count: z.number() }) },
      },
      handler: async (req) => req.body,
    });
    app.get('/v1/test/context', async (req) => ({
      role: req.context.role,
      userId: req.context.user?.id ?? null,
      requestId: req.context.requestId,
    }));
    const original = app.auditSink.append.bind(app.auditSink);
    app.auditSink.append = (event) => {
      auditedUrls.push(`${event.method} ${event.url} ${event.statusCode} ${event.actorId}`);
      return original(event);
    };
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('BE-010: /healthz returns status/commit/uptime/tradingMode without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.tradingMode).toBe('paper');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.commit).toBe('string');
  });

  it('BE-011: security headers present, CORS allows only the allowlist', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');

    const bad = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('BE-011: rate limit returns 429 with ApiError shape', async () => {
    const limited = await buildApp(testEnv({ RATE_LIMIT_MAX: '2' }));
    await limited.ready();
    await limited.inject({ method: 'GET', url: '/healthz' });
    await limited.inject({ method: 'GET', url: '/healthz' });
    const res = await limited.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(res.json().error.requestId).toBeTruthy();
    await limited.close();
  });

  it('BE-011: 404 uses the consistent error shape with requestId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('BE-012: invalid body yields 400 with field-level errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { 'x-internal-token': TOKEN },
      payload: { name: '', count: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION');
    const paths = error.details.map((d: { path: string }) => d.path);
    expect(paths).toContain('name');
    expect(paths).toContain('count');
  });

  it('BE-013: routes require the internal token; context is typed and populated', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/v1/test/context' });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json().error.code).toBe('UNAUTHORIZED');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/test/context',
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'internal', userId: 'internal' });
    expect(res.json().requestId).toBeTruthy();
  });

  it('BE-013: state-changing actions are audited', async () => {
    auditedUrls.length = 0;
    await app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { 'x-internal-token': TOKEN },
      payload: { name: 'fx', count: 1 },
    });
    await app.inject({ method: 'GET', url: '/healthz' }); // GET: not audited
    expect(auditedUrls).toEqual(['POST /v1/test/echo 200 internal']);
  });

  it('BE-015: OpenAPI 3.1 doc covers routes; /docs serves Swagger UI in non-prod', async () => {
    const doc = await app.inject({
      method: 'GET',
      url: '/docs/json',
      headers: { 'x-internal-token': TOKEN },
    });
    expect(doc.statusCode).toBe(200);
    const openapi = doc.json();
    expect(openapi.openapi).toBe('3.1.0');
    expect(openapi.paths['/healthz']).toBeDefined();
    expect(openapi.paths['/v1/test/echo']).toBeDefined();

    const ui = await app.inject({ method: 'GET', url: '/docs' });
    expect([200, 302]).toContain(ui.statusCode);
  });
});

describe('BE-014 — WebSocket gateway', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApp(testEnv());
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'object' && address) baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  function connect(url: string): Promise<WebSocket> {
    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolvePromise(socket), { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
  }

  function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise) => {
      socket.addEventListener('message', (e) => resolvePromise(JSON.parse(String(e.data))), {
        once: true,
      });
    });
  }

  it('rejects connections without a valid token (close 1008)', async () => {
    const socket = new WebSocket(`${baseUrl}/ws`);
    const code = await new Promise<number>((resolvePromise) => {
      socket.addEventListener('close', (e) => resolvePromise(e.code), { once: true });
    });
    expect(code).toBe(1008);
  });

  it('subscribes to a channel and receives published events', async () => {
    const socket = await connect(`${baseUrl}/ws?token=${TOKEN}`);

    const subscribed = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'subscribe', channel: 'user:internal:events' }));
    expect(await subscribed).toEqual({ type: 'subscribed', channel: 'user:internal:events' });

    const event = nextMessage(socket);
    app.eventBus.publish('user:internal:events', { kind: 'trade_opened', id: 't1' });
    const received = await event;
    expect(received.type).toBe('event');
    expect(received.channel).toBe('user:internal:events');
    expect(received.payload).toEqual({ kind: 'trade_opened', id: 't1' });

    const pong = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'ping' }));
    expect(await pong).toEqual({ type: 'pong' });

    socket.close();
  });

  it('rejects malformed messages with a typed error', async () => {
    const socket = await connect(`${baseUrl}/ws?token=${TOKEN}`);
    const err = nextMessage(socket);
    socket.send('not json');
    expect((await err).code).toBe('INVALID_JSON');

    const err2 = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'subscribe', channel: 'bad channel!!' }));
    expect((await err2).code).toBe('INVALID_MESSAGE');
    socket.close();
  });
});
