import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/observability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/observability.js')>();
  return {
    ...actual,
    persistFrontendLog: vi.fn(async () => {}),
  };
});

import { handleFrontendObservability } from '../src/handlers/observability.js';
import { handleRequest } from '../src/router.js';
import { persistFrontendLog } from '../src/lib/observability.js';
import { makeCtx } from './admin-helpers.js';

const mockedPersistFrontendLog = vi.mocked(persistFrontendLog);

function makeObservabilityRequest(
  body: string,
  contentType = 'application/json',
  extraHeaders: Record<string, string> = {},
): Request {
  const size = String(new TextEncoder().encode(body).byteLength);
  return new Request('https://api.local/api/observability/frontend', {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'content-length': size,
      ...extraHeaders,
    },
    body,
  });
}

describe('frontend observability ingestion diagnostics', () => {
  beforeEach(() => {
    mockedPersistFrontendLog.mockClear();
  });

  it('accepts application/json payloads', async () => {
    const ctx = makeCtx();
    const payload = { level: 'warn', eventType: 'frontend_event', message: 'hello' };
    const req = makeObservabilityRequest(JSON.stringify(payload), 'application/json');

    const res = await handleFrontendObservability(req, ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mockedPersistFrontendLog).toHaveBeenCalledWith(ctx.env, payload, req, ctx.executionCtx);
  });

  it('accepts text/plain JSON payloads (preflight-free sender path)', async () => {
    const ctx = makeCtx();
    const payload = { level: 'error', eventType: 'uncaught_exception', message: 'boom' };
    const req = makeObservabilityRequest(JSON.stringify(payload), 'text/plain;charset=UTF-8');

    const res = await handleFrontendObservability(req, ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mockedPersistFrontendLog).toHaveBeenCalledWith(ctx.env, payload, req, ctx.executionCtx);
  });

  it('rejects unsupported content types with explicit diagnostics', async () => {
    const ctx = makeCtx();
    const req = makeObservabilityRequest('{}', 'application/x-www-form-urlencoded');

    await expect(handleFrontendObservability(req, ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'Expected JSON or plain-text JSON payload.',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'frontend_observability_ingest_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_unsupported_content_type',
        deny_reason: 'unsupported_content_type',
        content_type: 'application/x-www-form-urlencoded',
      }),
    }));
  });

  it('rejects invalid JSON payloads with parse-failure diagnostics', async () => {
    const ctx = makeCtx();
    const req = makeObservabilityRequest('{broken-json', 'text/plain;charset=UTF-8');

    await expect(handleFrontendObservability(req, ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'Invalid observability payload.',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'frontend_observability_ingest_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_invalid_json_payload',
        deny_reason: 'invalid_json_payload',
      }),
    }));
  });

  it('rejects oversized payloads with explicit size diagnostics', async () => {
    const ctx = makeCtx();
    const req = makeObservabilityRequest(
      '{}',
      'application/json',
      { 'content-length': '20000' },
    );

    await expect(handleFrontendObservability(req, ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'Observability payload too large.',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'frontend_observability_ingest_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_payload_too_large',
        deny_reason: 'payload_too_large',
        content_length: 20000,
      }),
    }));
  });
});

describe('frontend observability router noise suppression', () => {
  beforeEach(() => {
    mockedPersistFrontendLog.mockClear();
  });

  it('does not emit generic request lifecycle logs for successful ingest', async () => {
    const ctx = makeCtx({
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
    });
    const req = makeObservabilityRequest(
      JSON.stringify({ level: 'warn', eventType: 'frontend_event', message: 'ok' }),
      'text/plain;charset=UTF-8',
      { Origin: 'https://letsilluminate.co' },
    );

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    expect(ctx.logger.logRequest).not.toHaveBeenCalled();
    expect(ctx.logger.logMilestone).not.toHaveBeenCalled();
  });

  it('still logs request diagnostics for rejected ingest attempts', async () => {
    const ctx = makeCtx({
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
    });
    const req = makeObservabilityRequest(
      '{}',
      'application/x-www-form-urlencoded',
      { Origin: 'https://letsilluminate.co' },
    );

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'Expected JSON or plain-text JSON payload.',
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    expect(ctx.logger.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/observability/frontend',
      statusCode: 400,
      success: true,
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'frontend_observability_ingest_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_unsupported_content_type',
      }),
    }));
  });
});
