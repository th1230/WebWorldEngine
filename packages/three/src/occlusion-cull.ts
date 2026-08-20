/**
 * 遮蔽剔除：把**確定被別的東西擋住**的 instance 從這一幀拿掉。
 *
 * ## 為什麼它自己一個檔案
 *
 * `InstancedMesh` 裡的東西大多互相纏著 —— HLOD 那一段要碰 36 個本體的欄位，
 * 因為它做的事就是「換掉本體要畫什麼」。遮蔽剔除不是：它從本體只要兩樣東西
 * （逐 instance 的矩陣、來源幾何），其餘要的都是這一幀的資料，明著傳進來。
 *
 * 那個差別是量出來的，不是憑感覺分的。契約窄的就分出來，纏得深的留著 ——
 * 硬分出去的代價是把 36 個私有欄位變成公開欄位，那比一個長檔案更糟。
 *
 * ## 它預設是關的
 *
 * 這個技巧在「少數大遮蔽物」的內容上有效（牆、山、建築各自穩穩蓋住一大塊）。
 * 在**密集散佈的小東西**上它幾乎剔不到 —— 實測兩萬顆石頭的場景剔掉 0 個，
 * 而每幀多花 1–4 ms 的 CPU。原因是兩層保守疊在一起：遮蔽物只能用內接盒，
 * 被測物要用外接球，兩個相乘之後幾乎沒有東西通得過。
 *
 * 那不是 bug，是這個技巧與這種內容不合。所以預設關，而且開著沒效果時會講。
 */
import { Matrix4 } from 'three';
import type { BufferGeometry } from 'three';
import { OcclusionBuffer } from '@ww/engine';
import { innerBox } from '@web-world-engine/format';

/**
 * 最多畫幾個遮蔽物。
 *
 * 密集散佈的內容裡遮蔽是**集體**的，所以這個數字不能小 —— 48 個的版本在
 * 兩萬顆石頭的場景上剔掉 0 個。
 */
const OCCLUDER_BUDGET = 2048;
/**
 * 螢幕大小要有最大那個的多少才值得畫進去。
 *
 * 比較的是螢幕大小的**平方**（省一次開根號），所以 0.01 相當於「邊長是
 * 最大那個的十分之一」。
 */
const OCCLUDER_SCORE_RATIO = 0.01;
/**
 * 少於這麼多 instance 就不做遮蔽剔除。
 *
 * 畫遮蔽物與重建粗層是**固定成本**，跟被測的數量無關。內容不夠多的時候
 * 那個固定成本收不回來 —— 而「省下來的要扣掉它自己的成本」是 doctrine
 * 第 9 條，材質那個旋鈕就是這樣被拿掉的。
 */
const MIN_OCCLUSION_INSTANCES = 512;

/** 連續這麼多幀幾乎沒剔到就講一次。 */
const USELESS_FRAMES_BEFORE_WARNING = 120;

const _boxClip = new Matrix4();
/** 遮蔽物的 8 個角，重複用。 */
const _occluderCorners = new Float32Array(32);
const _occluderMatrix = new Matrix4();

/**
 * 把區域空間的盒子變成裁剪空間的 8 個角，順序是 x + 2y + 4z。
 */
function writeBoxCorners(
  box: Float32Array,
  instance: Matrix4,
  viewProjection: Matrix4,
  out: Float32Array,
): void {
  const m = _boxClip.multiplyMatrices(viewProjection, instance).elements;
  let i = 0;
  for (let z = 0; z < 2; z++) {
    const bz = box[z * 3 + 2]!;
    for (let y = 0; y < 2; y++) {
      const by = box[y * 3 + 1]!;
      for (let x = 0; x < 2; x++) {
        const bx = box[x * 3]!;
        out[i++] = m[0]! * bx + m[4]! * by + m[8]! * bz + m[12]!;
        out[i++] = m[1]! * bx + m[5]! * by + m[9]! * bz + m[13]!;
        out[i++] = m[2]! * bx + m[6]! * by + m[10]! * bz + m[14]!;
        out[i++] = m[3]! * bx + m[7]! * by + m[11]! * bz + m[15]!;
      }
    }
  }
}

/**
 * 這一輪剔除要跟本體借的東西 —— 就這兩樣。
 *
 * 刻意寫成一個介面而不是直接吃 `InstancedMesh`：契約有多窄要看得見，
 * 不然下次有人多借一個欄位也不會有人發現。
 */
export interface OcclusionHost {
  /** 逐 instance 的世界矩陣（相對本體）。 */
  getMatrixAt(index: number, target: Matrix4): Matrix4;
  /** 內接盒要從它算。 */
  readonly sourceGeometry: BufferGeometry;
}

/**
 * 這一幀收集到的東西。
 *
 * 與套件裡其他效果同一個形狀 —— 排到第七個以後的位置參數沒有人記得住，
 * 而傳錯順序不會報錯（都是 number、都是 TypedArray）。
 */
export interface OcclusionFrame {
  /** 收集到幾個。 */
  drawCount: number;
  /** 走訪位置 → 槽位。 */
  slots: Int32Array;
  /** 逐槽位的包圍球（xyzr），區域空間。 */
  spheres: Float32Array;
  /** 相機在區域空間的位置。 */
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  /** 下面三個會被**就地改寫**成壓縮後的樣子。 */
  starts: Int32Array;
  counts: Int32Array;
  indirect: Uint32Array;
}

/** 剔除的結果。`kept` 是壓縮後還剩幾個。 */
export interface OcclusionResult {
  kept: number;
  occluded: number;
}

/**
 * 一個 `InstancedMesh` 的遮蔽剔除狀態。**開了才建。**
 */
export class OcclusionCuller {
  private readonly buffer = new OcclusionBuffer();
  /** 這一幀的區域空間 view-projection。緩衝與角點計算共用同一個。 */
  private readonly viewProjection = new Matrix4();
  private innerBoxLocal: Float32Array | null = null;
  private innerBoxComputed = false;
  private uselessFrames = 0;
  private warned = false;

  /** 上一幀剔掉幾個 —— `stats.occluded` 報的就是它。 */
  occluded = 0;

  /** 畫了幾個遮蔽物 —— `stats.occluders`。 */
  get occludersDrawn(): number {
    return this.buffer.occludersDrawn;
  }

  /**
   * 每幀在收集之前呼叫一次：告訴緩衝這一幀的視角。
   *
   * 包圍球是**區域空間**的，所以矩陣要一路乘到區域空間 —— 呼叫端算好傳進來。
   */
  setViewProjection(viewProjection: Matrix4, radiusScale: number): void {
    // 緩衝與 `writeBoxCorners` 要的是同一個矩陣 —— 存一份，不要讓呼叫端傳兩次。
    this.viewProjection.copy(viewProjection);
    this.buffer.setViewProjection(viewProjection.elements, radiusScale);
  }

  /** 緩衝的高度，算 `radiusScale` 要用。 */
  get height(): number {
    return this.buffer.height;
  }

  /**
   * 把被擋住的從清單裡拿掉，**就地壓縮**。
   *
   * `starts` / `counts` / `indirect` 三個陣列會被改寫成壓縮後的樣子，回傳
   * 還剩幾個。
   */
  cull(host: OcclusionHost, frame: OcclusionFrame): OcclusionResult {
    const { drawCount, slots, spheres, starts, counts, indirect } = frame;
    const camX = frame.cameraX;
    const camY = frame.cameraY;
    const camZ = frame.cameraZ;
    this.buffer.clear();

    const box = this.ensureInnerBox(host.sourceGeometry);
    // 沒有內接盒就沒有遮蔽物可畫。這一份幾何仍然可以被別的東西擋住，
    // 但這裡沒有別的東西 —— 所以直接返回，不做白工。
    if (box === null || drawCount < MIN_OCCLUSION_INSTANCES) {
      this.occluded = 0;
      return { kept: drawCount, occluded: 0 };
    }

    // ## 挑遮蔽物：門檻，不是「最大的 N 個」
    //
    // 第一版挑螢幕上最大的 48 個，而它在真實內容上**剔掉 0 個** —— 量出來
    // 遮蔽物確實畫進去了 47 個、測了 13,589 次，就是一次都沒成功。
    //
    // 原因是這種內容的遮蔽是**集體**的：兩萬顆石頭從 520 單位外看，每一顆
    // 都很小，沒有任何一顆單獨擋得住另一顆。擋住後面的是「前面那一大片」，
    // 而那一大片是幾千顆一起組成的。
    //
    // 所以改成門檻：**只要夠大就畫**，畫到預算用完為止。挑「最大的 N 個」
    // 那個直覺來自「幾棟大樓擋住一座城市」的場景，而它在密集散佈的內容上
    // 完全不成立。
    let maxScore = 0;
    for (let i = 0; i < drawCount; i++) {
      const s = slots[i]! * 4;
      const radius = spheres[s + 3]!;
      const dx = spheres[s]! - camX;
      const dy = spheres[s + 1]! - camY;
      const dz = spheres[s + 2]! - camZ;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq <= 1e-9) continue;
      const score = (radius * radius) / distanceSq;
      if (score > maxScore) maxScore = score;
    }
    // 最大的那個的一小部分。太高會漏掉集體遮蔽，太低會把時間花在畫不出
    // 幾個像素的東西上。
    const threshold = maxScore * OCCLUDER_SCORE_RATIO;

    let drawn = 0;
    for (let i = 0; i < drawCount && drawn < OCCLUDER_BUDGET; i++) {
      const s = slots[i]! * 4;
      const radius = spheres[s + 3]!;
      const dx = spheres[s]! - camX;
      const dy = spheres[s + 1]! - camY;
      const dz = spheres[s + 2]! - camZ;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq <= 1e-9) continue;
      if ((radius * radius) / distanceSq < threshold) continue;
      // `indirect` 裡放的就是 instance 編號，不必再從走訪位置換算一次。
      host.getMatrixAt(indirect[i]!, _occluderMatrix);
      writeBoxCorners(box, _occluderMatrix, this.viewProjection, _occluderCorners);
      if (this.buffer.addOccluder(_occluderCorners)) drawn++;
    }
    this.buffer.finish();

    // 遮蔽物自己也會被測 —— 它們一定測不掉（自己擋不住自己，因為門檻是
    // 自己的最遠點而它的最近點更近），所以不必特別跳過。
    let kept = 0;
    let occluded = 0;
    for (let i = 0; i < drawCount; i++) {
      const s = slots[i]! * 4;
      if (
        this.buffer.isSphereOccluded(spheres[s]!, spheres[s + 1]!, spheres[s + 2]!, spheres[s + 3]!)
      ) {
        occluded++;
        continue;
      }
      if (kept !== i) {
        starts[kept] = starts[i]!;
        counts[kept] = counts[i]!;
        indirect[kept] = indirect[i]!;
      }
      kept++;
    }
    this.occluded = occluded;
    this.warnIfUseless(drawCount, occluded);
    return { kept, occluded };
  }

  /**
   * 幾何的內接盒（區域空間），算一次。算不出來的話記住，不要每幀重試。
   *
   * `null` 代表算不出來（破面、太薄、平面）—— 那時這份幾何**不能當遮蔽物**，
   * 但它自己還是可以被別人擋住。
   */
  private ensureInnerBox(geometry: BufferGeometry): Float32Array | null {
    if (this.innerBoxComputed) return this.innerBoxLocal;
    this.innerBoxComputed = true;
    const position = geometry.getAttribute('position');
    if (position === undefined) return null;
    const index = geometry.getIndex();
    const found = innerBox(
      position.array as ArrayLike<number>,
      index === null ? null : (index.array as ArrayLike<number>),
    );
    if (found === null) return null;
    this.innerBoxLocal = new Float32Array([
      found.minX,
      found.minY,
      found.minZ,
      found.maxX,
      found.maxY,
      found.maxZ,
    ]);
    return this.innerBoxLocal;
  }

  /**
   * 白花力氣的話要講出來。
   *
   * **開著卻沒有效果**是使用者看不見的 —— 他只會覺得「開了好像沒變快」。
   * 而看不見的浪費最貴。
   */
  private warnIfUseless(drawCount: number, occluded: number): void {
    this.uselessFrames = occluded * 200 < drawCount ? this.uselessFrames + 1 : 0;
    if (this.uselessFrames !== USELESS_FRAMES_BEFORE_WARNING || this.warned) return;
    this.warned = true;
    console.warn(
      [
        `WW.InstancedMesh: 遮蔽剔除開著，但連續 ${USELESS_FRAMES_BEFORE_WARNING} 幀幾乎沒有剔到東西`,
        `（這一幀 ${drawCount} 個裡剔掉 ${occluded} 個），而它仍然要花 CPU。`,
        '這個技巧在**大遮蔽物**的內容上有效（牆、山、建築）；密集散佈的小東西',
        '幾乎剔不到 —— 遮蔽物只能用內接盒、被測物要用外接球，兩層保守疊起來',
        '之後通不過。這種內容關掉它會比較快。',
      ].join('\n'),
    );
  }
}
