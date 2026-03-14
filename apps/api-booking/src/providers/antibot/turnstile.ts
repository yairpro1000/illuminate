import { ApiError, badRequest, internalError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { IAntiBotProvider } from './interface.js';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileVerifyResult {
  success: boolean;
  challengeTs?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  errorCodes: string[];
  metadata?: Record<string, unknown>;
}

interface VerifyTurnstileTokenInput {
  secretKey: string;
  token: string;
  remoteIp?: string | null;
  idempotencyKey?: string | null;
}

export async function verifyTurnstileToken(input: VerifyTurnstileTokenInput): Promise<TurnstileVerifyResult> {
  const params = new URLSearchParams();
  params.set('secret', input.secretKey);
  params.set('response', input.token);
  if (input.remoteIp) params.set('remoteip', input.remoteIp);
  if (input.idempotencyKey) params.set('idempotency_key', input.idempotencyKey);

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch (error) {
    throw internalError('Turnstile verification returned an unreadable response');
  }

  if (!response.ok) {
    throw internalError('Turnstile verification transport failed');
  }

  const errorCodes = Array.isArray(payload['error-codes'])
    ? payload['error-codes'].filter((value): value is string => typeof value === 'string')
    : [];

  return {
    success: payload['success'] === true,
    challengeTs: typeof payload['challenge_ts'] === 'string' ? payload['challenge_ts'] : undefined,
    hostname: typeof payload['hostname'] === 'string' ? payload['hostname'] : undefined,
    action: typeof payload['action'] === 'string' ? payload['action'] : undefined,
    cdata: typeof payload['cdata'] === 'string' ? payload['cdata'] : undefined,
    errorCodes,
    metadata: typeof payload['metadata'] === 'object' && payload['metadata'] !== null
      ? payload['metadata'] as Record<string, unknown>
      : undefined,
  };
}

function mapTurnstileFailure(result: TurnstileVerifyResult): ApiError {
  if (result.errorCodes.includes('timeout-or-duplicate')) {
    return badRequest('Turnstile token expired or was already used', 'TURNSTILE_TOKEN_EXPIRED');
  }
  if (result.errorCodes.includes('missing-input-response')) {
    return badRequest('Turnstile token is required', 'TURNSTILE_TOKEN_MISSING');
  }
  return badRequest('Turnstile verification failed', 'TURNSTILE_TOKEN_INVALID');
}

export class TurnstileAntiBotProvider implements IAntiBotProvider {
  constructor(
    private readonly secretKey: string,
    private readonly logger?: Logger,
  ) {}

  async verify(token: string, remoteIp?: string | null): Promise<void> {
    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'turnstile_provider_verification_started',
      message: 'Started Turnstile provider verification',
      context: {
        provider: 'turnstile',
        branch_taken: 'verify_turnstile_token',
        has_token: !!token,
        remote_ip_present: !!remoteIp,
      },
    });

    if (!this.secretKey) {
      this.logger?.logWarn?.({
        source: 'backend',
        eventType: 'turnstile_provider_verification_denied',
        message: 'Turnstile provider secret key is missing',
        context: {
          provider: 'turnstile',
          branch_taken: 'deny_missing_turnstile_secret_key',
          deny_reason: 'turnstile_secret_key_missing',
        },
      });
      throw internalError('Turnstile secret key is not configured');
    }

    if (!token || !token.trim()) {
      this.logger?.logWarn?.({
        source: 'backend',
        eventType: 'turnstile_provider_verification_denied',
        message: 'Turnstile provider rejected an empty token',
        context: {
          provider: 'turnstile',
          branch_taken: 'deny_missing_turnstile_token',
          deny_reason: 'turnstile_token_missing',
        },
      });
      throw badRequest('Turnstile token is required', 'TURNSTILE_TOKEN_MISSING');
    }

    const result = await verifyTurnstileToken({
      secretKey: this.secretKey,
      token: token.trim(),
      remoteIp,
      idempotencyKey: crypto.randomUUID(),
    });

    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'turnstile_provider_verification_decision',
      message: 'Evaluated Turnstile provider verification result',
      context: {
        provider: 'turnstile',
        branch_taken: result.success ? 'allow_turnstile_token' : 'deny_turnstile_token',
        deny_reason: result.success ? null : (result.errorCodes[0] ?? 'turnstile_verification_failed'),
        error_codes: result.errorCodes,
        hostname: result.hostname ?? null,
        action: result.action ?? null,
      },
    });

    if (!result.success) {
      throw mapTurnstileFailure(result);
    }
  }
}
