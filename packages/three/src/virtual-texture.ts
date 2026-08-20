import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import { PageTable, type PageLoad, type VirtualTextureLayout } from '@webworld/format';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';

/**
 * 虛擬貼圖：一張大到硬體配置不下的貼圖，用一張配置得下的來畫。
 *
 * ## 它補的是「做不做得到」，不是「快不快」
 *
 * 先前量過貼圖壓力，結論是不做 —— 而那個量測回答的是「需不需要它來變快」：
 * 有 mipmap 的話工作集受畫面像素數綁住，貼圖總量堆到 5.5 GB 幀時間都不動。
 * 那個結論還是對的。
 *
 * 但硬體的單張貼圖有上限（`maxTextureSize`，常見 16384）。一個 8 公里、
 * 每 10 公分一個 texel 的地表要 80,000 texel 一邊 —— **那不是慢，是配置
 * 不出來**。跟 CSM 是同一種理由：範圍拉大到某個程度，單張 map 就不成立。
 *
 * ## 三張東西
 *
 * | | 是什麼 |
 * | --- | --- |
 * | 圖集 | 真正存在的貼圖，住得下 `atlasPages²` 頁 |
 * | 頁表 | 每一格說「這一塊該去圖集哪裡拿」，**必須用 NEAREST** |
 * | 住民管理 | 在 `@webworld/format` 的 `PageTable`，純邏輯所以測得動 |
 *
 * 頁表用 NEAREST 不是效能取捨，是**正確性**：內插兩個頁位址會得到第三個
 * 不存在的位址，畫面上是隨機的碎塊。這種錯不會報錯。
 *
 * ## 階數是 CPU 選的，圖集自己不做 mipmap
 *
 * 一般貼圖靠 mipmap 決定用多細的版本。這裡不行 —— 圖集裡相鄰的兩格是完全
 * 不相干的兩頁，做 mipmap 會把它們混在一起。
 *
 * 所以**階數就是頁的階數**：要多細由呼叫端在 `request()` 時決定（照距離），
 * 而頁表回退的那一階就是實際畫出來的細緻度。與這個引擎其他地方一致 ——
 * 選階在 CPU，而且看得到、量得到。
 *
 * ## 每頁留邊
 *
 * 圖集裡兩頁貼在一起，線性取樣在邊界上會吃到隔壁那頁。所以每頁四周留
 * `border` 個 texel 的重複邊，取樣時往內縮。
 *
 * 沒有這個的話症狀是**每一頁的邊緣有一圈別的地方的顏色**，而它只在特定
 * 縮放下看得見 —— 那種 bug 很難從截圖上認出來。
 */

export interface VirtualTextureOptions extends VirtualTextureLayout {
  /**
   * 每頁四周留幾個 texel 的重複邊。預設 4。
   *
   * 0 的話頁與頁的邊界會互相吃到對方（線性取樣跨過去了）。
   */
  border?: number;
  /**
   * 產生一頁的內容，RGBA，長度是 `size * size * 4`。
   *
   * `size` 含邊 —— 也就是 `pageSize`，而中間那 `pageSize - 2 * border`
   * 才是這一頁真正的內容，四周那圈要填鄰接的內容（或直接複製邊緣）。
   *
   * 回傳 Promise 的話這一頁會在解決之後才裝上去，期間頁表指著較粗的祖先
   * ——也就是「糊一下然後變清楚」，而不是破洞。
   */
  page: (level: number, px: number, py: number, size: number) => Uint8Array | Promise<Uint8Array>;
}

export class VirtualTexture {
  readonly table: PageTable;
  /** 真正存在的那張貼圖。 */
  readonly atlas: DataTexture;
  /** 頁表。NEAREST，不可以改成 LINEAR。 */
  readonly indirection: DataTexture;
  readonly border: number;

  /** 診斷：搬了幾頁、現在住了幾頁、有幾頁在路上。 */
  pagesLoaded = 0;

  private readonly atlasSize: number;
  private readonly atlasData: Uint8Array;
  private readonly provider: VirtualTextureOptions['page'];
  private readonly inFlight = new Set<string>();
  private disposed = false;

  constructor(options: VirtualTextureOptions) {
    this.table = new PageTable(options);
    this.border = Math.max(0, Math.floor(options.border ?? 4));
    if (this.border * 2 >= this.table.pageSize) {
      throw new Error(
        `WW.VirtualTexture: border（${this.border}）吃掉了整頁（pageSize ${this.table.pageSize}）。`,
      );
    }
    this.provider = options.page;

    this.atlasSize = this.table.pageSize * this.table.atlasPages;
    this.atlasData = new Uint8Array(this.atlasSize * this.atlasSize * 4);
    const atlas = new DataTexture(
      this.atlasData,
      this.atlasSize,
      this.atlasSize,
      RGBAFormat,
      UnsignedByteType,
    );
    atlas.minFilter = LinearFilter;
    atlas.magFilter = LinearFilter;
    // ## 圖集不做 mipmap
    //
    // 相鄰兩格是不相干的兩頁，做 mipmap 會把它們混在一起 —— 遠處於是出現
    // 兩塊地形糊成一團的顏色。細緻度改由頁的階數決定。
    atlas.generateMipmaps = false;
    atlas.wrapS = ClampToEdgeWrapping;
    atlas.wrapT = ClampToEdgeWrapping;
    atlas.needsUpdate = true;
    this.atlas = atlas;

    const table = new DataTexture(
      this.table.indirection,
      this.table.pagesPerSide,
      this.table.pagesPerSide,
      RGBAFormat,
      UnsignedByteType,
    );
    // **NEAREST 是正確性，不是效能。** 內插兩個頁位址會得到第三個不存在的
    // 位址，畫面上是隨機碎塊，而且不會報錯。
    table.minFilter = NearestFilter;
    table.magFilter = NearestFilter;
    table.generateMipmaps = false;
    table.wrapS = ClampToEdgeWrapping;
    table.wrapT = ClampToEdgeWrapping;
    table.needsUpdate = true;
    this.indirection = table;

    // ## 釘住的那一頁要**現在**就搬進來
    //
    // `PageTable` 在建構時就把最粗那一階標成住著的（它是回退鏈的底），但那
    // 只是頁表上的登記 —— 圖集裡那一格還是空的。`commit()` 只回報**新加進去**
    // 的頁，所以它永遠不會被搬。
    //
    // 症狀：還沒要任何細頁時整張是黑的，而黑跟「shader 沒編譯成功」長得一樣。
    // 關卡就是這樣抓到它的。
    this.install({
      level: this.table.levels - 1,
      px: 0,
      py: 0,
      slotX: this.table.rootSlot.slotX,
      slotY: this.table.rootSlot.slotY,
    });
  }

  /** 假裝出來的解析度。這個數字超過 `maxTextureSize` 就是這東西的存在理由。 */
  get virtualSize(): number {
    return this.table.pageSize * this.table.pagesPerSide;
  }

  /** 登記這一輪要用到的頁。搬在 `update()`，而且有預算。 */
  request(level: number, px: number, py: number): void {
    this.table.request(level, px, py);
  }

  /**
   * 登記一塊 UV 區域在某個階數要用到的所有頁。
   *
   * 地形那一類的用法：把相機視錐投影到地表得到一塊 UV，照距離決定階數。
   */
  requestRegion(u0: number, v0: number, u1: number, v1: number, level: number): void {
    const side = Math.max(1, this.table.pagesPerSide >> level);
    const x0 = Math.max(0, Math.floor(Math.min(u0, u1) * side));
    const x1 = Math.min(side - 1, Math.floor(Math.max(u0, u1) * side));
    const y0 = Math.max(0, Math.floor(Math.min(v0, v1) * side));
    const y1 = Math.min(side - 1, Math.floor(Math.max(v0, v1) * side));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.table.request(level, x, y);
    }
  }

  /**
   * 把這一輪要到的頁搬進圖集。
   *
   * @returns 這一次開始搬幾頁（同步的 provider 已經搬完，非同步的還在路上）。
   */
  update(budget = 8): number {
    const loads = this.table.commit(budget);
    for (const load of loads) this.install(load);
    this.indirection.needsUpdate = true;
    return loads.length;
  }

  private install(load: PageLoad): void {
    const size = this.table.pageSize;
    const k = `${load.level}:${load.px}:${load.py}`;
    const pixels = this.provider(load.level, load.px, load.py, size);
    if (pixels instanceof Uint8Array) {
      this.blit(pixels, load.slotX, load.slotY);
      return;
    }
    this.inFlight.add(k);
    void pixels.then(
      (data) => {
        this.inFlight.delete(k);
        // 等回來的時候這一格可能已經被別人用了 —— 那就丟掉，不要覆蓋。
        if (this.disposed) return;
        this.blit(data, load.slotX, load.slotY);
        this.atlas.needsUpdate = true;
      },
      () => {
        this.inFlight.delete(k);
      },
    );
  }

  /** 把一頁寫進圖集的一格。 */
  private blit(pixels: Uint8Array, slotX: number, slotY: number): void {
    const size = this.table.pageSize;
    if (pixels.length < size * size * 4) {
      throw new Error(
        `WW.VirtualTexture: 一頁要 ${size * size * 4} 個位元組（含邊），拿到 ${pixels.length}。`,
      );
    }
    const originX = slotX * size;
    const originY = slotY * size;
    for (let y = 0; y < size; y++) {
      const src = y * size * 4;
      const dst = ((originY + y) * this.atlasSize + originX) * 4;
      this.atlasData.set(pixels.subarray(src, src + size * 4), dst);
    }
    this.atlas.needsUpdate = true;
    this.pagesLoaded++;
  }

  /**
   * 把這張虛擬貼圖接到一個材質的 `map` 上。
   *
   * 走 `onBeforeCompile` —— 與這個套件其他 WebGL 的鉤子一致：不換渲染器，
   * 只換取樣那一行。
   */
  apply(material: Material): void {
    // ## 材質必須先有一張 map
    //
    // 取樣那一行接在 `<map_fragment>` 上，而 Three 只有在 `USE_MAP` 成立時
    // 才宣告 `vMapUv`。沒有 map 的話這段 shader **編譯不過** —— 而那個失敗
    // 的樣子是畫面全黑加主控台一行紅字，很容易被當成別的問題。
    //
    // 隨便一張 1×1 就夠（內容會被虛擬貼圖蓋掉），要的只是那個 define。
    if (!('map' in material) || (material as unknown as { map: unknown }).map === null) {
      throw new Error(
        'WW.VirtualTexture.apply: 這個材質沒有 map。' +
          '取樣接在 <map_fragment> 上，而 Three 只有在有 map 時才宣告 vMapUv —— ' +
          '沒有的話 shader 編譯不過（畫面全黑）。先給一張 1×1 的貼圖佔位，內容會被蓋掉。',
      );
    }

    const uniforms = {
      wwVtAtlas: { value: this.atlas },
      wwVtTable: { value: this.indirection },
      wwVtParams: {
        // x: 最細階一邊幾頁  y: 圖集一邊幾頁  z: 一頁幾 texel  w: 邊幾 texel
        value: [this.table.pagesPerSide, this.table.atlasPages, this.table.pageSize, this.border],
      },
    };

    // ## node 材質走另一份
    //
    // `onBeforeCompile` 是 WebGL 那條路的鉤子，`WebGPURenderer` 整條編譯路徑
    // **不經過它**。只做一邊的症狀是整片地形是那張 1×1 的佔位貼圖 —— 一片
    // 純白，看起來像「貼圖沒載到」。
    //
    // 那份是動態 import 的（`three/tsl` 只有 WebGPU 用得到），所以接上去是
    // 非同步的。`nodeReady` 讓測試等得到它。
    if ((material as { isNodeMaterial?: boolean }).isNodeMaterial === true) {
      this.nodeReady = import('./virtual-texture-node.ts').then((m) =>
        m.applyVirtualTextureNode(material as never, this.atlas, this.indirection, {
          pagesPerSide: this.table.pagesPerSide,
          atlasPages: this.table.atlasPages,
          pageSize: this.table.pageSize,
          border: this.border,
        }),
      );
      return;
    }

    const previous = material.onBeforeCompile.bind(material);
    material.onBeforeCompile = (parameters: WebGLProgramParametersWithUniforms, renderer): void => {
      previous(parameters, renderer);
      Object.assign(parameters.uniforms, uniforms);

      parameters.fragmentShader = parameters.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'uniform sampler2D wwVtAtlas;',
            'uniform sampler2D wwVtTable;',
            'uniform vec4 wwVtParams;',
            '',
            'vec4 wwSampleVirtual( vec2 vUvIn ) {',
            '  float pagesPerSide = wwVtParams.x;',
            '  float atlasPages = wwVtParams.y;',
            '  float pageSize = wwVtParams.z;',
            '  float border = wwVtParams.w;',
            '',
            '  vec2 uv = clamp( vUvIn, 0.0, 0.999999 );',
            '  // 頁表是 NEAREST 的，所以這一次查表拿到的是「這一格」的位址，',
            '  // 不是附近幾格的平均 —— 平均出來的位址不存在。',
            '  vec4 entry = texture2D( wwVtTable, uv );',
            '  vec2 slot = floor( entry.xy * 255.0 + 0.5 );',
            '  float level = floor( entry.z * 255.0 + 0.5 );',
            '',
            '  // 住著的那一頁蓋住 2^level 個最細階的頁。UV 換算到那一頁裡面。',
            '  float span = exp2( level );',
            '  vec2 pageUv = fract( uv * pagesPerSide / span );',
            '',
            '  // 往內縮一圈：圖集裡兩頁貼在一起，線性取樣在邊界會吃到隔壁。',
            '  float usable = pageSize - 2.0 * border;',
            '  vec2 inPage = ( pageUv * usable + border ) / pageSize;',
            '  vec2 atlasUv = ( slot + inPage ) / atlasPages;',
            '  return texture2D( wwVtAtlas, atlasUv );',
            '}',
          ].join('\n'),
        )
        .replace('#include <map_fragment>', 'diffuseColor *= wwSampleVirtual( vMapUv );');
    };
    material.needsUpdate = true;
  }

  /**
   * node 材質那條路接好了沒。WebGL 上一直是 `null`（那條路是同步的）。
   *
   * 存在的理由與其他幾個一樣：關卡需要一個「現在可以量了」的確定時點。
   */
  nodeReady: Promise<void> | null = null;

  dispose(): void {
    this.disposed = true;
    this.atlas.dispose();
    this.indirection.dispose();
  }
}
