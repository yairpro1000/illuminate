export function createConsoleLogger() {
  function emit(level, method, entry) {
    method(JSON.stringify({ level, ...entry }));
  }

  return {
    info(entry) {
      emit('info', console.log, entry);
    },
    warn(entry) {
      emit('warn', console.warn, entry);
    },
    error(entry) {
      emit('error', console.error, entry);
    },
  };
}
