import type { Env } from './env.js';
import { createProviders } from './providers/index.js';
import { handleRequest }   from './router.js';
import { createLogger }    from './lib/logger.js';
import { runCron }         from './handlers/jobs.js';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const logger    = createLogger(requestId);
    const providers = createProviders(env);

    logger.info('request', {
      method:  request.method,
      url:     new URL(request.url).pathname,
    });

    return handleRequest(request, { providers, env, logger, requestId });
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const requestId = crypto.randomUUID();
    const logger    = createLogger(requestId, 'cron');
    const providers = createProviders(env);

    logger.info('cron triggered', { cron: event.cron });

    try {
      await runCron(event.cron, { providers, env, logger, requestId });
    } catch (err) {
      logger.error('cron failed', { cron: event.cron, err: String(err) });
    }
  },
};
