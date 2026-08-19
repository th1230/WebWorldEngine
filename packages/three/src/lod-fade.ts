/**
 * 換階時的抖動交叉淡入。
 *
 * ## 為什麼不是「錯開換階的距離」
 *
 * 最直覺的做法是讓每個 instance 的換階門檻各差一點，這樣一整片不會同時跳。
 * 那個做法做過也量過了，**它不值得**：
 *
 * | | 最忙的一幀換了幾個 |
 * | --- | ---: |
 * | 散開的兩萬顆，沒錯開 | 75 |
 * | 散開的兩萬顆，錯開 12% | 75（**完全一樣**） |
 * | 密集的兩萬顆，沒錯開 | 692 |
 * | 密集的兩萬顆，錯開 12% | 634（省 8%） |
 * | 密集的兩萬顆，錯開 40% | 579（省 16%，但換階總數多了 32%） |
 *
 * 散開的內容本來就在不同距離上，門檻錯不錯開都一樣；密集的內容錯開 40% 也只
 * 省 16%，而代價是一堆 instance 多撐著細階不放。所以那條路被拿掉了。
 *
 * ## 真正的做法：兩個階同時畫，用抖動決定每個像素用哪一個
 *
 * 過渡期間同一個 instance 畫兩次 —— 細階與粗階各一次 —— 而每個像素只有其中
 * 一次會留下來。留哪一個由一張 4×4 的 Bayer 矩陣與過渡進度比較決定。
 *
 * 兩半的條件是**互補的**（一個取 `<`，一個取 `>=`），所以覆蓋率剛好是 100%：
 * 不會有破洞，也不會畫兩層。
 *
 * 這是 UE 的 dithered LOD transition 同一個做法。抖動之所以夠用，是因為相鄰
 * 像素選到不同階，而兩階的差別本來就 ≤ `errorPixels`（2 像素）——肉眼在那個
 * 尺度上分不出來，只看得到「平滑地換過去」。
 *
 * ## 為什麼靠 gl_DrawID 而不是改 Three 的內部
 *
 * 過渡中的那幾筆繪製被排在**最後面**，分成兩塊：先是細階那一半，再是粗階那
 * 一半。著色器因此只要比對 `gl_DrawID` 就知道自己是誰，而過渡進度放在一個
 * uniform 陣列裡。
 *
 * 這條路完全走 `onBeforeCompile`，沒有碰 Three 的批次內部 —— 與 ADR-0001
 * 那條「不重包 Three.js」一致。
 *
 * 代價是 uniform 陣列有上限（`LOD_FADE_CAPACITY`）。超過的 instance 就照舊
 * 直接換階，而那是**安全的退化**：畫面回到今天的樣子，不是壞掉。
 */

/** 一幀最多幾個 instance 在過渡。超過的照舊直接換階。 */
export const LOD_FADE_CAPACITY = 128;

export const LOD_FADE_VERTEX_GLSL = /* glsl */ `
uniform int wwFadeFineStart;
uniform int wwFadeCoarseStart;
uniform int wwFadeCount;
uniform float wwFadeAmount[ ${LOD_FADE_CAPACITY} ];
varying float wwFade;
varying float wwFadeHalf;

void wwSetupLodFade() {
  wwFade = -1.0;
  wwFadeHalf = 0.0;
  if ( wwFadeCount <= 0 || gl_DrawID < wwFadeFineStart ) return;
  int slot = gl_DrawID < wwFadeCoarseStart
    ? gl_DrawID - wwFadeFineStart
    : gl_DrawID - wwFadeCoarseStart;
  if ( slot < 0 || slot >= wwFadeCount ) return;
  // GLSL ES 3.0 允許用變數索引 uniform 陣列。
  wwFade = wwFadeAmount[ slot ];
  wwFadeHalf = gl_DrawID < wwFadeCoarseStart ? 0.0 : 1.0;
}
`;

export const LOD_FADE_FRAGMENT_GLSL = /* glsl */ `
varying float wwFade;
varying float wwFadeHalf;

/**
 * 4×4 的 Bayer 矩陣。
 *
 * 用有序抖動而不是亂數：亂數會讓同一個像素每幀選到不同的階，那看起來是雜訊
 * 在閃。有序抖動是**固定的圖樣**，相機不動時畫面也不動。
 */
float wwBayer( vec2 coordinate ) {
  int x = int( mod( coordinate.x, 4.0 ) );
  int y = int( mod( coordinate.y, 4.0 ) );
  int index = x + y * 4;
  float table[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return table[ index ] / 16.0;
}

void wwApplyLodFade() {
  if ( wwFade < 0.0 ) return;
  float threshold = wwBayer( gl_FragCoord.xy );
  // 兩半的條件互補 —— 覆蓋率剛好一次，不破洞也不疊兩層。
  if ( wwFadeHalf < 0.5 ) {
    // 細階：進度越大留得越少。
    if ( threshold < wwFade ) discard;
  } else {
    // 粗階：進度越大留得越多。
    if ( threshold >= wwFade ) discard;
  }
}
`;
