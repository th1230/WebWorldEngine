import { describe, expect, it } from 'vitest';
import { fnv1a32, hashObject, stableStringify } from './hash.ts';

describe('fnv1a32', () => {
  it('matches known FNV-1a 32-bit vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('always returns an unsigned 32-bit integer', () => {
    for (const s of ['', 'a', 'hello world', '中文', 'x'.repeat(1000)]) {
      const h = fnv1a32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('stableStringify', () => {
  it('is independent of property order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('preserves array order', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('skips undefined properties', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('handles nesting and null', () => {
    expect(stableStringify({ a: { y: 1, x: null } })).toBe(stableStringify({ a: { x: null, y: 1 } }));
  });
});

describe('hashObject', () => {
  it('gives the same cache key regardless of key order', () => {
    const a = { vendor: 'nvidia', device: '4060', features: ['a', 'b'] };
    const b = { features: ['a', 'b'], device: '4060', vendor: 'nvidia' };
    expect(hashObject(a)).toBe(hashObject(b));
  });

  it('changes when any value changes', () => {
    const base = hashObject({ vendor: 'nvidia', maxTextureSize: 16384 });
    expect(hashObject({ vendor: 'nvidia', maxTextureSize: 8192 })).not.toBe(base);
    expect(hashObject({ vendor: 'amd', maxTextureSize: 16384 })).not.toBe(base);
  });
});
