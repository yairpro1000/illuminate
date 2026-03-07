export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(requestId: string, prefix?: string): Logger {
  const tag = prefix ? `[${prefix}]` : '[worker]';

  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    console.log(
      JSON.stringify({ level, requestId, tag, msg, ...data, ts: new Date().toISOString() }),
    );
  };

  return {
    info:  (msg, data) => emit('info',  msg, data),
    warn:  (msg, data) => emit('warn',  msg, data),
    error: (msg, data) => emit('error', msg, data),
  };
}
