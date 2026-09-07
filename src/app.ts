import { buildServer } from './api/server.js';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { prisma } from './db/prisma.js';
import { processDueSteps } from './modules/growth/sequences.js';

// Interval for the sequence step scheduler (runs every 60s)
const SEQUENCE_SCHEDULER_INTERVAL_MS = 60_000;

function startSequenceScheduler() {
  const interval = setInterval(async () => {
    try {
      await processDueSteps();
    } catch (err) {
      logger.error({ err }, 'Sequence scheduler tick failed');
    }
  }, SEQUENCE_SCHEDULER_INTERVAL_MS);

  // Don't keep the process alive just for the timer
  interval.unref();
  logger.info('Sequence scheduler started (60s interval)');
  return interval;
}

async function main() {
  const server = await buildServer();
  const scheduler = startSequenceScheduler();

  try {
    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(`CrossReach server listening on :${config.PORT}`);
    logger.info(`Environment: ${config.NODE_ENV}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    clearInterval(scheduler);
    await server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
