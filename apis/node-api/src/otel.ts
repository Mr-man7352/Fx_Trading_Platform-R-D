/**
 * BE-140 — OpenTelemetry bootstrap (Fastify → BullMQ → gRPC → Prisma → Tempo).
 *
 * MUST be loaded before any instrumented module resolves, so it is a separate
 * build entry wired via Node's `--import` flag (see package.json `start*`
 * scripts and the Dockerfile CMD), NOT imported from server/worker code:
 *
 *   node --import ./dist/otel.js dist/server.js
 *
 * No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (dev without a collector
 * boots clean). Spans export over OTLP/HTTP to the collector/Tempo endpoint —
 * local stack: `pnpm stack:up` + the `observability` profile
 * (infra/observability/README.md), which serves Tempo on :4318.
 *
 * Covered: HTTP server (Fastify routes), ioredis, pg, @grpc/grpc-js (the
 * Phase-2 BE-068 client picks this up automatically), Prisma
 * (@prisma/instrumentation), and BullMQ jobs via BullMQ's native telemetry
 * hook (`bullmq-otel`, attached where queues/workers are constructed —
 * workers/market-data.ts).
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
// NOTE: 1.x API (`new Resource`) — matches sdk-node 0.5x. The 2.x line renames
// this to `resourceFromAttributes`; update together when bumping the SDK.
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'fx-node-api',
      [ATTR_SERVICE_VERSION]: process.env.GIT_COMMIT ?? 'dev',
      'deployment.environment': process.env.TRADING_MODE ?? 'paper',
    }),
    traceExporter: new OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are pure noise at our volume.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => req.url === '/healthz' || req.url === '/metrics', // probe noise
        },
      }),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();
  console.log(`[otel] tracing enabled → ${endpoint}`); // bootstrap line before logger wiring

  const shutdown = () => {
    // Flush pending spans; never block process exit on the collector.
    sdk.shutdown().catch(() => {});
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('beforeExit', shutdown);
}
