declare const BRAND: unique symbol;

type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/**
 * Branded id。
 * 避免之後大量 `number` 互相混用造成的錯誤。
 */
export type EntityId = Brand<number, 'EntityId'>;
export type WorldCellId = Brand<string, 'WorldCellId'>;

export const asEntityId = (value: number): EntityId => value as EntityId;
export const asWorldCellId = (value: string): WorldCellId => value as WorldCellId;

/** 單調遞增的幀序號。GPU timing 非同步回來時用它把結果歸屬回正確的幀。 */
export type FrameId = number;

export type Milliseconds = number;
export type Seconds = number;
export type Bytes = number;
