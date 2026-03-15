export function normalizeLowercasePrefix(raw) {
  const value = raw?.trim().toLowerCase() ?? '';
  return value || null;
}

export function escapeLikePrefix(prefix) {
  return prefix.replace(/[%_]/g, (match) => `\\${match}`);
}

export function chunkValues(values, size = 100) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('chunk size must be a positive integer');
  }

  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
