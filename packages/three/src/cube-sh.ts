/**
 * 把一張 cubemap 的六個面投影成 SH 係數。
 *
 * ## 為什麼不直接用 `three/addons` 的 `LightProbeGenerator`
 *
 * 用過，而且它算的是對的。換掉的理由**不是數學，是同步點**。
 *
 * 那個函式在自己的迴圈裡逐面 `await readRenderTargetPixelsAsync`，六個面就是
 * 六次 GPU→CPU 同步。實測拆開來看：
 *
 * | | 時間 |
 * | --- | ---: |
 * | 把場景畫六次 | **0.3 ms** |
 * | 投影＋讀回 | **36.8 ms** |
 *
 * 而且把面寬從 4 開到 32（像素多 64 倍）那個 36.8 ms **完全不動** —— 所以它
 * 不是在算，是在等。等六次。
 *
 * 一顆探針 37 ms 的話：256 顆要 9.4 秒，`budgetMs` 那個參數形同虛設（預設 8，
 * 實際每次超出四倍半），而「烘的時候畫面照樣流暢」那句話是假的。
 *
 * 把讀回與投影拆開之後，呼叫端就可以**先把很多顆的讀回都發出去、最後一次
 * 等完**，六次同步變成一幀一次。
 *
 * ## 數學與 Three 完全一樣
 *
 * 座標對應、權重、SH 基底、正規化全部照 `LightProbeGenerator` 逐行搬過來 ——
 * 這裡要的是少等幾次，不是換一套慣例。慣例差一點的症狀是亮度差一截或方向
 * 反了，而且不會報錯。
 *
 * 而「一樣」這件事有測試守著，比對的還不是那個 addon，是**封閉解**：均勻
 * 環境的輻照度必須是 πL，而那個答案與實作無關。
 */
import { SphericalHarmonics3, Vector3 } from 'three';

/** 一個面的像素，RGBA。半精度是 `Uint16Array`，單精度是 `Float32Array`。 */
export type FacePixels = Uint16Array | Float32Array | Uint8Array;

export interface CubeProjectionOptions {
  /** 每個面的邊長（假設是正方形）。 */
  faceSize: number;
  /**
   * 座標系翻轉。WebGL 是 −1，WebGPU 是 1。
   *
   * 拿錯的話 SH 的方向會左右相反 —— 光從錯的邊來，而畫面上那是「看起來
   * 怪怪的」，不是錯誤訊息。
   */
  flip: number;
  /** 像素怎麼變成線性亮度。半精度要 `fromHalfFloat`，8 位元要除 255。 */
  decode: (value: number) => number;
}

/**
 * 六個面 → 9 個 SH 係數（L2）。前 4 個就是 L1。
 *
 * @param faces 依序是 +x, −x, +y, −y, +z, −z —— 與 `readRenderTargetPixels`
 *   的 faceIndex 0…5 相同。
 */
export function projectCubeToSH(
  faces: readonly FacePixels[],
  options: CubeProjectionOptions,
): SphericalHarmonics3 {
  const { faceSize, flip, decode } = options;
  const sh = new SphericalHarmonics3();
  const coefficients = sh.coefficients;
  const basis = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const coord = new Vector3();
  const dir = new Vector3();
  const pixelSize = 2 / faceSize;
  let totalWeight = 0;

  for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
    const data = faces[faceIndex];
    if (data === undefined) continue;

    for (let i = 0; i < faceSize * faceSize * 4; i += 4) {
      const r = decode(data[i]!);
      const g = decode(data[i + 1]!);
      const b = decode(data[i + 2]!);

      // 單位立方體上的座標。這一段與 Three 的 LightProbeGenerator 逐行相同。
      const pixelIndex = i / 4;
      const col = (1 - ((pixelIndex % faceSize) + 0.5) * pixelSize) * flip;
      const row = 1 - (Math.floor(pixelIndex / faceSize) + 0.5) * pixelSize;

      switch (faceIndex) {
        case 0:
          coord.set(-1 * flip, row, col * flip);
          break;
        case 1:
          coord.set(1 * flip, row, -col * flip);
          break;
        case 2:
          coord.set(col, 1, -row);
          break;
        case 3:
          coord.set(col, -1, row);
          break;
        case 4:
          coord.set(col, row, 1);
          break;
        default:
          coord.set(-col, row, -1);
          break;
      }

      // 立方體上每個像素對應的立體角不一樣 —— 角落的比中心的小。這個權重
      // 就是那個修正，少了它天空的貢獻會被高估。
      const lengthSq = coord.lengthSq();
      const weight = 4 / (Math.sqrt(lengthSq) * lengthSq);
      totalWeight += weight;

      dir.copy(coord).normalize();
      SphericalHarmonics3.getBasisAt(dir, basis);

      for (let j = 0; j < 9; j++) {
        coefficients[j]!.x += basis[j]! * r * weight;
        coefficients[j]!.y += basis[j]! * g * weight;
        coefficients[j]!.z += basis[j]! * b * weight;
      }
    }
  }

  // 正規化成整顆球的立體角 4π。
  const norm = (4 * Math.PI) / Math.max(totalWeight, 1e-9);
  for (let j = 0; j < 9; j++) coefficients[j]!.multiplyScalar(norm);
  return sh;
}
