import type { Env } from '../env.js';
import {
  dedupeTechnicalRows,
  selectTechnicalRowsByEq,
  selectTechnicalRowsByIn,
  type TechnicalObservabilityRow,
} from './technical-observability-core.js';

export async function listBookingObservabilityRows(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  input: {
    bookingId: string;
    bookingEventIds?: string[];
    sideEffectIds?: string[];
    sideEffectAttemptIds?: string[];
    includeApiLogs?: boolean;
    includeExceptionLogs?: boolean;
  },
): Promise<{ apiLogs: TechnicalObservabilityRow[]; exceptionLogs: TechnicalObservabilityRow[] }> {
  const bookingEventIds = input.bookingEventIds ?? [];
  const sideEffectIds = input.sideEffectIds ?? [];
  const sideEffectAttemptIds = input.sideEffectAttemptIds ?? [];

  const [apiLogs, exceptionLogs] = await Promise.all([
    !input.includeApiLogs
      ? Promise.resolve([] as TechnicalObservabilityRow[])
      : Promise.all([
          selectTechnicalRowsByEq(env, 'api_logs', 'booking_id', input.bookingId),
          selectTechnicalRowsByIn(env, 'api_logs', 'booking_event_id', bookingEventIds),
          selectTechnicalRowsByIn(env, 'api_logs', 'side_effect_id', sideEffectIds),
          selectTechnicalRowsByIn(env, 'api_logs', 'side_effect_attempt_id', sideEffectAttemptIds),
        ]).then((rows) => dedupeTechnicalRows(rows.flat())),
    !input.includeExceptionLogs
      ? Promise.resolve([] as TechnicalObservabilityRow[])
      : Promise.all([
          selectTechnicalRowsByEq(env, 'exception_logs', 'booking_id', input.bookingId),
          selectTechnicalRowsByIn(env, 'exception_logs', 'booking_event_id', bookingEventIds),
          selectTechnicalRowsByIn(env, 'exception_logs', 'side_effect_id', sideEffectIds),
          selectTechnicalRowsByIn(env, 'exception_logs', 'side_effect_attempt_id', sideEffectAttemptIds),
        ]).then((rows) => dedupeTechnicalRows(rows.flat())),
  ]);

  return { apiLogs, exceptionLogs };
}
