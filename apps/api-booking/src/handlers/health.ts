import { ok } from '../lib/errors.js';

export async function handleHealth(): Promise<Response> {
  return ok({ ok: true });
}
