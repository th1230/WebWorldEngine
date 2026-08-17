import { describe, expect, it } from 'vitest';
import { Float64RingBuffer } from './ring-buffer.ts';

describe('Float64RingBuffer', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new Float64RingBuffer(0)).toThrow();
    expect(() => new Float64RingBuffer(-1)).toThrow();
    expect(() => new Float64RingBuffer(1.5)).toThrow();
  });

  it('grows up to capacity before wrapping', () => {
    const rb = new Float64RingBuffer(3);
    expect(rb.size).toBe(0);
    expect(rb.isFull).toBe(false);

    rb.push(1);
    rb.push(2);
    expect(rb.size).toBe(2);
    expect(Array.from(rb.toArray())).toEqual([1, 2]);
    expect(rb.last()).toBe(2);
  });

  it('keeps oldest-to-newest order after wrapping', () => {
    const rb = new Float64RingBuffer(3);
    for (const v of [1, 2, 3, 4, 5]) rb.push(v);

    expect(rb.size).toBe(3);
    expect(rb.isFull).toBe(true);
    expect(Array.from(rb.toArray())).toEqual([3, 4, 5]);
    expect(rb.at(0)).toBe(3);
    expect(rb.at(2)).toBe(5);
    expect(rb.last()).toBe(5);
  });

  it('wraps correctly across many full cycles', () => {
    const rb = new Float64RingBuffer(4);
    for (let i = 0; i < 100; i++) rb.push(i);
    expect(Array.from(rb.toArray())).toEqual([96, 97, 98, 99]);
  });

  it('throws on out-of-range access rather than returning garbage', () => {
    const rb = new Float64RingBuffer(3);
    rb.push(1);
    expect(() => rb.at(1)).toThrow();
    expect(() => rb.at(-1)).toThrow();

    const empty = new Float64RingBuffer(3);
    expect(() => empty.last()).toThrow();
  });

  it('reuses a caller-supplied output array without allocating', () => {
    const rb = new Float64RingBuffer(3);
    for (const v of [1, 2, 3, 4]) rb.push(v);
    const out = new Float64Array(3);
    const result = rb.toArray(out);
    expect(result).toBe(out);
    expect(Array.from(out)).toEqual([2, 3, 4]);
  });

  it('clears back to empty', () => {
    const rb = new Float64RingBuffer(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.isFull).toBe(false);
    rb.push(9);
    expect(Array.from(rb.toArray())).toEqual([9]);
  });
});
