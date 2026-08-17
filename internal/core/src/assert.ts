export class AssertionError extends Error {
  override readonly name = 'AssertionError';
}

export function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new AssertionError(message);
}

/** 斷言值非 null/undefined 並回傳它，方便在運算式中使用。 */
export function invariant<T>(value: T | null | undefined, message = 'Expected a value'): T {
  if (value === null || value === undefined) throw new AssertionError(message);
  return value;
}

/** 用於 switch 的窮盡性檢查；若型別未被窮盡，這裡會是編譯期錯誤。 */
export function unreachable(value: never, message = 'Unreachable'): never {
  throw new AssertionError(`${message}: ${JSON.stringify(value)}`);
}
