import type { AppContext } from '../router.js';
import { ApiError, badRequest, internalError, ok } from '../lib/errors.js';
import { verifyTurnstileToken } from '../providers/antibot/turnstile.js';

type TurnstileTestScenario = 'pass' | 'fail';

function resolveScenario(body: Record<string, unknown>): TurnstileTestScenario {
  const raw = typeof body['scenario'] === 'string' ? body['scenario'].trim().toLowerCase() : '';
  if (raw === 'pass' || raw === 'fail') return raw;
  throw badRequest('scenario must be "pass" or "fail"', 'TURNSTILE_TEST_SCENARIO_INVALID');
}

function requireToken(body: Record<string, unknown>): string {
  const token = typeof body['token'] === 'string' ? body['token'].trim() : '';
  if (!token) throw badRequest('token is required', 'TURNSTILE_TOKEN_MISSING');
  return token;
}

function resolveScenarioSecret(ctx: AppContext, scenario: TurnstileTestScenario): string {
  return scenario === 'pass'
    ? (ctx.env.TURNSTILE_TEST_SECRET_KEY_PASS || '')
    : (ctx.env.TURNSTILE_TEST_SECRET_KEY_FAIL || '');
}

// POST /api/antibot/turnstile/verify
export async function handleTurnstileVerify(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'turnstile_test_verify_started',
    message: 'Started Turnstile test verification request',
    context: {
      path,
      request_id: ctx.requestId,
      antibot_mode: ctx.env.ANTIBOT_MODE,
      branch_taken: 'evaluate_turnstile_test_verification',
    },
  });

  try {
    const body = await request.json() as Record<string, unknown>;
    const scenario = resolveScenario(body);
    const token = requireToken(body);

    const configuredSecret = resolveScenarioSecret(ctx, scenario);
    const modeEnabled = ctx.env.ANTIBOT_MODE === 'turnstile';

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'turnstile_test_verify_config_evaluated',
      message: 'Evaluated Turnstile test verification config state',
      context: {
        path,
        request_id: ctx.requestId,
        antibot_mode: ctx.env.ANTIBOT_MODE,
        scenario,
        has_secret: !!configuredSecret,
        branch_taken: !modeEnabled
          ? 'deny_antibot_mode_not_turnstile'
          : !configuredSecret
            ? 'deny_missing_turnstile_test_secret'
            : 'allow_turnstile_test_verification',
        deny_reason: !modeEnabled
          ? 'antibot_mode_not_turnstile'
          : !configuredSecret
            ? `turnstile_test_secret_missing_${scenario}`
            : null,
      },
    });

    if (!modeEnabled) {
      throw new ApiError(409, 'ANTIBOT_MODE_INACTIVE', 'ANTIBOT_MODE must be set to "turnstile"');
    }

    if (!configuredSecret) {
      throw internalError(`Missing Turnstile test secret for scenario "${scenario}"`);
    }

    const result = await verifyTurnstileToken({
      secretKey: configuredSecret,
      token,
      remoteIp: request.headers.get('CF-Connecting-IP'),
      idempotencyKey: crypto.randomUUID(),
    });

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'turnstile_test_verify_decision',
      message: 'Evaluated Turnstile test verification result',
      context: {
        path,
        request_id: ctx.requestId,
        scenario,
        branch_taken: result.success ? 'allow_turnstile_test_token' : 'deny_turnstile_test_token',
        deny_reason: result.success ? null : (result.errorCodes[0] ?? 'turnstile_verification_failed'),
        hostname: result.hostname ?? null,
        action: result.action ?? null,
        error_codes: result.errorCodes,
      },
    });

    if (!result.success) {
      throw new ApiError(400, 'TURNSTILE_TOKEN_INVALID', 'Turnstile verification failed');
    }

    return ok({
      ok: true,
      scenario,
      hostname: result.hostname ?? null,
      action: result.action ?? null,
      challenge_ts: result.challengeTs ?? null,
      error_codes: result.errorCodes,
      request_id: ctx.requestId,
    });
  } catch (error) {
    const statusCode = error instanceof ApiError ? error.statusCode : 500;
    const errorCode = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
    const errorMessage = error instanceof ApiError ? error.message : 'Internal server error';
    ctx.operation.latestInboundErrorCode = errorCode;
    ctx.operation.latestInboundErrorMessage = errorMessage;

    if (error instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'turnstile_test_verify_failed',
        message: error.message,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          error_code: errorCode,
          branch_taken: 'handled_api_error',
          deny_reason: errorCode,
        },
      });
    } else {
      ctx.logger.captureException?.({
        source: 'backend',
        eventType: 'turnstile_test_verify_failed',
        message: 'Turnstile test verification failed unexpectedly',
        error,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
        },
      });
    }
    throw error;
  }
}
