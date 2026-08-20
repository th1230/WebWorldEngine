/* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的，見 fullscreen-node.ts */
import { LOD_FADE_CAPACITY } from './lod-fade.ts';

/**
 * 換階淡入的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 逐行對照 `lod-fade.ts` 的兩段 GLSL：同一個 4×4 有序抖動、同一個互補的
 * 覆蓋條件、同一份靠繪製編號分辨自己是誰的邏輯。
 *
 * ## 為什麼一定要有兩份
 *
 * WebGL 那條路靠 `onBeforeCompile` 注入，而 `WebGPURenderer` 整條編譯路徑
 * **不經過那個鉤子**。只做一邊的症狀是 WebGPU 上換階變回硬跳 —— 而那看起來
 * 像「淡入沒開」或「這個距離本來就會跳一下」，不像有一半的實作沒接上。
 *
 * ## 接的地方：`maskNode`
 *
 * Three 的 `NodeMaterial` 有一個現成的鉤子就是這件事：
 *
 * ```js
 * if ( this.maskNode !== null ) bool( this.maskNode ).not().discard();
 * ```
 *
 * 用它而不是去改 `colorNode`／`opacityNode`：那兩個一碰就會蓋掉材質原本的
 * 貼圖與透明度，而 `maskNode` 只回答「這個 fragment 留不留」。
 *
 * 而且**要先接住原本那個**。搶掉的話別人掛在上面的遮罩會消失，那與
 * `onBeforeCompile` 是單一插槽是同一個坑。
 *
 * ## 繪製編號
 *
 * WebGL 那份讀 `gl_DrawID`。TSL 這邊 Three 自己的 `batch()` 是這樣寫的：
 *
 * ```js
 * const batchingIdNode = builder.getDrawIndex() === null ? instanceIndex : drawIndex;
 * ```
 *
 * 抄它 —— multi-draw 走 `drawIndex`，沒有的話退回 `instanceIndex`。自己另外
 * 想一套的話兩邊在「一次畫幾筆」上分岔，而那不會報錯。
 */

export interface LodFadeUniformSource {
  wwFadeFineStart: { value: number };
  wwFadeCoarseStart: { value: number };
  wwFadeCount: { value: number };
  wwFadeAmount: { value: Float32Array };
}

interface MaskableNodeMaterial {
  isNodeMaterial?: boolean;
  maskNode?: unknown;
  needsUpdate?: boolean;
}

/** 每幀要把新的值推進去 —— 見 `applyLodFadeNode` 裡的說明。 */
export interface LodFadeNodeHandle {
  update: () => void;
}

/**
 * 把換階淡入接到一個 node 材質上。
 *
 * 失敗時**丟例外**而不是靜靜跳過 —— 靜靜跳過的症狀是換階變回硬跳，而那
 * 看起來像效果沒開。
 *
 * ## 回傳的 `update` **每幀都要呼叫**
 *
 * `uniform( 5 )` 包住的是**那個數字**，不是那個物件 —— 之後改來源的
 * `.value` 一個字都不會傳過去。（`uniform( vector3 )` 才是包物件，
 * `irradiance-node.ts` 靠的就是那個差別。）
 *
 * 漏掉的症狀很會騙人：淡入**看起來是在動的**（抖動、混色都有），只是
 * 進度停在建材質那一刻的值。實測跨後端關卡量到的是「兩邊都在混色，但
 * 比例差 17%」—— 不像壞掉，像實作不一樣。
 */
export async function applyLodFadeNode(
  material: MaskableNodeMaterial,
  uniforms: LodFadeUniformSource,
): Promise<LodFadeNodeHandle> {
  const tsl = (await import('three/tsl')) as any;
  const {
    Fn,
    If,
    bool,
    float,
    int,
    uniform,
    uniformArray,
    varying,
    screenCoordinate,
    drawIndex,
    instanceIndex,
    mod,
    vec2,
  } = tsl;

  const uFineStart = uniform(int(0));
  const uCoarseStart = uniform(int(0));
  const uCount = uniform(int(0));
  // 陣列包的是**同一個 Float32Array**，所以就地改元素會被上傳；上面三個
  // 純數字的不行，要靠 `update` 推。
  const uAmount = uniformArray(uniforms.wwFadeAmount.value);

  /**
   * 4×4 的 Bayer 矩陣。
   *
   * 用有序抖動而不是亂數：亂數會讓同一個像素每幀選到不同的階，那看起來是
   * 雜訊在閃。有序抖動是固定的圖樣，相機不動時畫面也不動。
   *
   * GLSL 那份用一個 `float[16]` 的常數陣列配變數索引。這裡展開成十六段
   * `select` —— 值與 GLSL 那份逐格相同，只是查表的方式不一樣。
   *
   * 抖動的圖樣本身用的是螢幕座標，而兩個後端的 y 原點相反 —— 也就是圖樣
   * 上下顛倒。那不影響任何一條主張：兩半用的是**同一個像素的同一個門檻**，
   * 所以互補性成立，而覆蓋率（唯一量得到的東西）與圖樣的方向無關。
   */
  const bayer = (coordinate: any): any => {
    const x = int(mod(coordinate.x, 4));
    const y = int(mod(coordinate.y, 4));
    const index = x.add(y.mul(4));
    // 展開的查表：table[index] / 16
    const table = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    let value = float(table[0]! / 16);
    for (let i = 1; i < table.length; i++) {
      value = index.equal(int(i)).select(float(table[i]! / 16), value);
    }
    return value;
  };

  // ## 進度與哪一半走 varying
  //
  // GLSL 那份在頂點著色器算完傳過來。這裡一樣 —— 繪製編號在頂點階段就知道，
  // 每個 fragment 各算一次是白花。
  const fadeSetup = Fn((_params: unknown, builder: any) => {
    // Three 自己的 `batch()` 就是這樣問的 —— multi-draw 才有 `drawIndex`，
    // 沒有的話一次繪製只有一個 instance，退回 `instanceIndex`。
    const id = int(builder.getDrawIndex() === null ? instanceIndex : drawIndex);
    const fade = float(-1).toVar();
    const half = float(0).toVar();
    If(uCount.greaterThan(0).and(id.greaterThanEqual(uFineStart)), () => {
      const slot = id.lessThan(uCoarseStart).select(id.sub(uFineStart), id.sub(uCoarseStart)).toVar();
      If(slot.greaterThanEqual(0).and(slot.lessThan(uCount)), () => {
        fade.assign(uAmount.element(slot));
        half.assign(id.lessThan(uCoarseStart).select(float(0), float(1)));
      });
    });
    return vec2(fade, half);
  });

  const vFade = varying(fadeSetup(), 'wwLodFade');

  const keep = Fn(() => {
    const fade = vFade.x.toVar();
    const half = vFade.y.toVar();
    const alive = bool(true).toVar();
    If(fade.greaterThanEqual(0), () => {
      const threshold = bayer(screenCoordinate).toVar();
      // 兩半的條件互補 —— 覆蓋率剛好一次，不破洞也不疊兩層。
      If(half.lessThan(0.5), () => {
        // 細階：進度越大留得越少。
        alive.assign(threshold.greaterThanEqual(fade));
      }).Else(() => {
        // 粗階：進度越大留得越多。
        alive.assign(threshold.lessThan(fade));
      });
    });
    return alive;
  })();

  const previous = material.maskNode;
  material.maskNode = previous === null || previous === undefined ? keep : bool(previous).and(keep);
  material.needsUpdate = true;

  return {
    update: () => {
      uFineStart.value = uniforms.wwFadeFineStart.value;
      uCoarseStart.value = uniforms.wwFadeCoarseStart.value;
      uCount.value = uniforms.wwFadeCount.value;
    },
  };
}

/** 給呼叫端一個「這個材質是不是 node 材質」的判斷，不必自己記那個旗標。 */
export function isNodeMaterial(material: unknown): boolean {
  return (material as { isNodeMaterial?: boolean }).isNodeMaterial === true;
}

/** 容量與 WebGL 那份共用 —— 兩份分岔的話超過容量的行為會不一樣。 */
export const NODE_LOD_FADE_CAPACITY = LOD_FADE_CAPACITY;
