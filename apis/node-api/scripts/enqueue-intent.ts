#!/usr/bin/env tsx
/**
 * BE-050 — dev trigger: create an approved paper-mode TradeIntent and enqueue execution.
 *
 * Usage:
 *   pnpm --filter @fx/node-api enqueue-intent -- EUR_USD long 10000 1.10 1.09 1.12
 *   (instrument side units entry stopLoss takeProfit)
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createPrismaClient } from '../src/db.js';
import { loadEnv } from '../src/env.js';
import { EXECUTION_QUEUE } from '../src/workers/queues.js';

const env = loadEnv();
const args = process.argv.slice(2).filter((a) => a !== '--');

if (args.length < 6) {
  console.error(
    'Usage: enqueue-intent <instrument> <long|short> <units> <entry> <stopLoss> [takeProfit]',
  );
  process.exit(1);
}

const [instrument, side, units, entry, stopLoss, takeProfit] = args;
if (side !== 'long' && side !== 'short') {
  console.error('side must be long or short');
  process.exit(1);
}

const prisma = createPrismaClient(env);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(EXECUTION_QUEUE, { connection: connection as never });

const signalId = randomUUID();
await prisma.signal.create({
  data: {
    id: signalId,
    barTs: new Date(),
    instrument,
    timeframe: 'H1',
    side: side as 'long' | 'short',
    tradingMode: env.TRADING_MODE,
    status: 'approved',
  },
});

const intent = await prisma.tradeIntent.create({
  data: {
    signalId,
    instrument,
    side: side as 'long' | 'short',
    units,
    entryPrice: entry,
    stopLoss,
    takeProfit: takeProfit ?? null,
    riskPct: 0.01,
    riskGate: { verdict: 'approved', source: 'enqueue-intent' },
    status: 'approved',
    tradingMode: env.TRADING_MODE,
    decidedAt: new Date(),
  },
});

// BullMQ 5 forbids ':' in custom job ids.
await queue.add('execute', { intentId: intent.id }, { jobId: `execution-${intent.id}` });

console.log(`Enqueued execution for intent ${intent.id} (${instrument} ${side} ${units})`);

await queue.close();
connection.disconnect();
await prisma.$disconnect();
