import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * FE-090 seam closer — a thin authenticated Node proxy in front of the
 * QN-055 quant REST endpoints (the quant service is not exposed to the
 * browser; Node fronts it, per "Node never does maths" — this is transport
 * only, no reshaping):
 *
 *   GET /quant/models/:instrument/:timeframe/:version/calibration
 *   GET /quant/regime/:instrument?timeframe=H1&bars=500
 *
 * Status codes pass through (404 unknown model version, 422 too few bars).
 * The quant service being down surfaces as 503 QUANT_UNAVAILABLE — the
 * dashboard renders its calm seam state, never a fabricated curve.
 */
export function registerQuantProxyRoutes(app: FastifyInstance): void {
  const base = app.env.QUANT_HTTP_URL.replace(/\/$/, '');

  // FE-090 — model registry list (Node's own DB; Python is the only writer).
  app.get(
    '/quant/models',
    { schema: { tags: ['quant'], summary: 'Model registry entries (champion/challenger roles)' } },
    async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) {
        return reply.code(503).send({
          error: { code: 'DB_UNAVAILABLE', message: 'Database not configured', requestId: req.id },
        });
      }
      const rows = await prisma.modelRegistryEntry.findMany({
        orderBy: [{ instrument: 'asc' }, { timeframe: 'asc' }, { version: 'desc' }],
        take: 100,
      });
      return {
        models: rows.map((m) => ({
          instrument: m.instrument,
          timeframe: String(m.timeframe),
          version: m.version,
          role: m.role,
          calibrationMethod: m.calibrationMethod,
          trainedAt: m.trainedAt.toISOString(),
          promotedAt: m.promotedAt ? m.promotedAt.toISOString() : null,
          metrics: m.metrics ?? null,
        })),
      };
    },
  );

  async function proxy(req: FastifyRequest, reply: FastifyReply, path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return reply.code(503).send({
        error: {
          code: 'QUANT_UNAVAILABLE',
          message: 'Quant service is not reachable',
          requestId: req.id,
        },
      });
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return reply.code(res.status).send(
        body ?? {
          error: { code: 'QUANT_ERROR', message: `quant HTTP ${res.status}`, requestId: req.id },
        },
      );
    }
    return reply.send(body);
  }

  app.get<{ Params: { instrument: string; timeframe: string; version: string } }>(
    '/quant/models/:instrument/:timeframe/:version/calibration',
    { schema: { tags: ['quant'], summary: 'QN-055 calibration curve (proxied)' } },
    async (req, reply) => {
      const { instrument, timeframe, version } = req.params;
      const safe = [instrument, timeframe, version].map(encodeURIComponent);
      return proxy(req, reply, `/models/${safe[0]}/${safe[1]}/${safe[2]}/calibration`);
    },
  );

  app.get<{ Params: { instrument: string }; Querystring: { timeframe?: string; bars?: string } }>(
    '/quant/regime/:instrument',
    { schema: { tags: ['quant'], summary: 'QN-055 regime timeline (proxied)' } },
    async (req, reply) => {
      const { instrument } = req.params;
      const qs = new URLSearchParams();
      if (req.query.timeframe) qs.set('timeframe', req.query.timeframe);
      if (req.query.bars) qs.set('bars', req.query.bars);
      const suffix = qs.toString() ? `?${qs}` : '';
      return proxy(req, reply, `/regime/${encodeURIComponent(instrument)}${suffix}`);
    },
  );
}
