import type { Env } from './env.js';
import { createProviders } from './providers/index.js';
import { handleRequest }   from './router.js';
import { createCronObservability, createWorkerObservability } from './lib/logger.js';
import { createOperationContext } from './lib/execution.js';
import {
  finalizeApiLog,
  recordExceptionLog,
  responseUrl,
  startApiLog,
  wrapProvidersForOperation,
} from './lib/technical-observability.js';
import { runCron }         from './handlers/jobs.js';
import { errorBody, jsonResponse } from './lib/errors.js';
import { addCorsIfAllowed } from './lib/cors.js';

function inferAppAreaFromPath(pathname: string): 'website' | 'admin' {
  return pathname.startsWith('/api/admin/') ? 'admin' : 'website';
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
      const { logger, requestId, correlationId } = createWorkerObservability(env, request, executionCtx);
      const pathname = new URL(request.url).pathname;
      const operation = createOperationContext({
        appArea: inferAppAreaFromPath(pathname),
        requestId,
        correlationId,
      });
      const startedAtMs = Date.now();
      const inboundApiLogId = await startApiLog(env, {
        operation,
        direction: 'inbound',
        method: request.method,
        url: request.url,
        requestHeaders: request.headers,
        requestBody: request.method === 'GET' || request.method === 'HEAD' ? null : '[stream body omitted]',
      });

      try {
        const providers = createProviders(env, logger);
        const response = await handleRequest(request, {
          providers,
          env,
          logger,
          requestId,
          correlationId,
          operation,
          executionCtx,
        });
        await finalizeApiLog(env, inboundApiLogId, {
          responseStatus: response.status,
          responseHeaders: response.headers,
          responseBody: response.status >= 400 ? await response.clone().text() : { ok: response.ok, path: responseUrl(request) },
          errorCode: response.status >= 400 ? operation.latestInboundErrorCode : null,
          errorMessage: response.status >= 500 ? operation.latestInboundErrorMessage : null,
          startedAtMs,
        });
        return response;
      } catch (error) {
      await finalizeApiLog(env, inboundApiLogId, {
        responseStatus: 500,
        responseBody: errorBody(error, requestId),
        errorCode: typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'INTERNAL_ERROR',
        errorMessage: error instanceof Error ? error.message : 'Internal server error',
        startedAtMs,
      });
      await recordExceptionLog(env, operation, error, {
        method: request.method,
        path: pathname,
        branch_taken: 'worker_fetch_entrypoint_failed',
        status_code: 500,
      }, typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'INTERNAL_ERROR');
      logger.captureException({
        eventType: 'uncaught_exception',
        message: 'Worker fetch entrypoint failed',
        error,
        context: {
          method: request.method,
          path: new URL(request.url).pathname,
        },
      });
      return addCorsIfAllowed(
        request,
        jsonResponse({ error: 'INTERNAL_ERROR', message: 'Internal server error', request_id: requestId }, 500),
        env.SITE_URL,
        env.API_ALLOWED_ORIGINS,
        !!env.ADMIN_DEV_EMAIL,
      );
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, executionCtx: ExecutionContext): Promise<void> {
    const { logger, requestId, correlationId } = createCronObservability(env, event.cron, executionCtx);
    const operation = createOperationContext({ appArea: 'website', requestId, correlationId });
    const providers = wrapProvidersForOperation(createProviders(env, logger), env, logger, operation);

    logger.logMilestone('cron_started', { cron: event.cron, request_id: requestId });

    try {
      await runCron(event.cron, { providers, env, logger, requestId, correlationId, operation, triggerSource: 'cron' });
      logger.logMilestone('cron_completed', { cron: event.cron, request_id: requestId });
    } catch (err) {
      logger.captureException({
        eventType: 'uncaught_exception',
        message: 'Cron run failed',
        error: err,
        source: 'cron',
        context: { cron: event.cron },
      });
    }
  },
};
