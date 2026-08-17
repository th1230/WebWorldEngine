/**
 * FNV-1a 32-bit。用途是產生 capability / tier 快取的 cache key，
 * 不是密碼學雜湊，也不需要跨語言一致。
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619，用移位避免超過 32-bit 精度
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export function hashString(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, '0');
}

/**
 * 對物件做穩定雜湊：key 依字典序排序後序列化，
 * 因此 property 順序改變不會讓 cache 失效。
 */
export function hashObject(value: unknown): string {
  return hashString(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
