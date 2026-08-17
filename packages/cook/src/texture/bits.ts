/**
 * 區塊格式共用的位元讀寫。
 *
 * BC7 的欄位不對齊位元組（7 位元的端點、4 位元的索引、7 位元的 mode），
 * 手動移位很快就會寫錯。抽出來集中處理，比在編碼器與解碼器裡各寫一份
 * 移位邏輯安全得多 —— 那兩份一旦不一致，症狀是「圖看起來怪怪的」。
 *
 * **LSB-first**：位元 0 是第一個位元組的最低位，這是 BC7 規格的順序。
 */

export class BitWriter {
  private bit = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly base: number,
  ) {}

  /** 寫入 `count` 個位元（取 `value` 的低位）。 */
  write(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if (((value >>> i) & 1) !== 0) {
        const index = this.base + (this.bit >> 3);
        this.bytes[index] = this.bytes[index]! | (1 << (this.bit & 7));
      }
      this.bit++;
    }
  }

  get bitsWritten(): number {
    return this.bit;
  }
}

export class BitReader {
  private bit = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly base: number,
  ) {}

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const index = this.base + (this.bit >> 3);
      value |= ((this.bytes[index]! >> (this.bit & 7)) & 1) << i;
      this.bit++;
    }
    return value >>> 0;
  }

  get bitsRead(): number {
    return this.bit;
  }
}
