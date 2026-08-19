import * as THREE from 'three';

/**
 * 量「畫出去的東西裡，有多少一個像素都沒留下」。
 *
 * ## 為什麼要先量這個
 *
 * roadmap 把遮蔽剔除標成下一條軸，但那是**推論**出來的，不是量出來的。
 * [doctrine](../../../specs/doctrine.md) 第 5 條：先量再做。
 *
 * 遮蔽剔除能省的上限就是「送進去畫、結果完全看不見的那些」。這個數字如果
 * 是 3%，那整條軸就不值得做 —— 而做完才發現不值得，是最貴的一種浪費。
 *
 * ## 做法：把 instance 編號畫成顏色，再數畫面上有幾個編號
 *
 * 開一張與畫面同樣大小的 render target，用一份覆寫材質把每個 instance 的
 * 編號編碼成 RGB 畫進去，**深度測試照常**。畫完讀回來，數出現過幾個編號。
 *
 * 出現在畫面上的編號 = 真的被看見的。送出去的數量減掉它，就是白畫的。
 *
 * ## 這個數字的意思與不是的意思
 *
 * 它是**上限**，不是遮蔽剔除能拿到的量：
 *
 * | 算進去的 | 為什麼 |
 * | --- | --- |
 * | 被別的東西完全擋住 | 這才是遮蔽剔除要處理的 |
 * | 小到沒蓋到任何一個像素中心 | 這是選階的事，不是遮蔽的事 |
 * | 只有背面朝著相機 | 背面剔除已經在做了 |
 *
 * 所以量到的是「最多能省這麼多」。上限如果就很小，下面就不必再談了。
 *
 * ## 為什麼解析度要跟畫面一樣
 *
 * 縮小的話小東西會整個消失，於是它們被算成「看不見」—— 而那是量測的假象，
 * 不是真的可以剔除。往「可以省很多」的方向作弊，正好是最危險的方向。
 */

export interface OcclusionResult {
  /** 這一幀送出去畫的 instance 數。 */
  submitted: number;
  /** 畫面上真的出現過的 instance 數。 */
  visible: number;
  /** 一個像素都沒留下的比例 0–1。 */
  wasted: number;
  /** 畫面上有多少像素被這些 instance 蓋到。 */
  covered: number;
}

/**
 * 覆寫材質：把 instance 編號畫成顏色。
 *
 * 編號從 1 開始，0 留給「不是批次幾何的東西」—— 地形、地面那些。它們**還是
 * 要畫**，因為它們要寫深度去擋住別人；只是不參與計數。
 */
function makeIdMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial();
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 wwIdColor;')
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          '{',
          // 與頂點動畫那邊同一個寫法：`batchId` 這個變數**不存在**，
          // Three 的批次 chunk 沒有把索引存成具名變數。
          '  float wwId = 0.0;',
          '  #ifdef USE_BATCHING',
          '    wwId = float( getIndirectIndex( gl_DrawID ) ) + 1.0;',
          '  #endif',
          '  float wwR = mod( wwId, 256.0 );',
          '  float wwG = mod( floor( wwId / 256.0 ), 256.0 );',
          '  float wwB = mod( floor( wwId / 65536.0 ), 256.0 );',
          '  wwIdColor = vec3( wwR, wwG, wwB ) / 255.0;',
          '}',
        ].join('\n'),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 wwIdColor;')
      // ## 取代色彩空間轉換那一步，不是加在它後面
      //
      // 編號是**資料**，不是顏色。讓它經過 sRGB 編碼的話讀回來的位元組
      // 全部是錯的，而解出來的編號會是一堆看起來很合理的垃圾 —— 那種錯
      // 不會報錯，只會讓「可見數量」變成一個假的大數字。
      .replace('#include <colorspace_fragment>', 'gl_FragColor = vec4( wwIdColor, 1.0 );');
  };
  return material;
}

/**
 * 畫一次 ID 圖，數出真的看得見的 instance。
 *
 * @param submitted 這一幀送出去畫的數量。由呼叫端提供 —— 只有它知道
 *   自己那一份統計是從哪裡來的。
 */
/**
 * 畫一次 ID 圖，回傳畫面上真的出現過的編號（從 1 開始，0 是非批次幾何）。
 *
 * 分出來是因為「完美剔除器能省多少時間」那個量測要拿這份集合去藏東西，
 * 而不只是要一個數量。
 */
export function occludedIds(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Set<number> {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    colorSpace: THREE.NoColorSpace,
    depthBuffer: true,
  });

  const previousOverride = scene.overrideMaterial;
  const previousTarget = renderer.getRenderTarget();
  const idMaterial = makeIdMaterial();

  scene.overrideMaterial = idMaterial;
  renderer.setRenderTarget(target);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);

  const pixels = new Uint8Array(size.x * size.y * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size.x, size.y, pixels);

  renderer.setRenderTarget(previousTarget);
  scene.overrideMaterial = previousOverride;
  idMaterial.dispose();
  target.dispose();

  const seen = new Set<number>();
  for (let i = 0; i < pixels.length; i += 4) {
    const id = pixels[i]! + pixels[i + 1]! * 256 + pixels[i + 2]! * 65536;
    if (id !== 0) seen.add(id);
  }
  return seen;
}

export function measureOccluded(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  submitted: number,
): OcclusionResult {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    // 讀回來的必須是原始位元組。給它 sRGB 的話 Three 會在寫入時做轉換。
    colorSpace: THREE.NoColorSpace,
    depthBuffer: true,
  });

  const previousOverride = scene.overrideMaterial;
  const previousTarget = renderer.getRenderTarget();
  const idMaterial = makeIdMaterial();

  scene.overrideMaterial = idMaterial;
  renderer.setRenderTarget(target);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);

  const pixels = new Uint8Array(size.x * size.y * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size.x, size.y, pixels);

  renderer.setRenderTarget(previousTarget);
  scene.overrideMaterial = previousOverride;
  idMaterial.dispose();
  target.dispose();

  const seen = new Set<number>();
  let covered = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const id = pixels[i]! + pixels[i + 1]! * 256 + pixels[i + 2]! * 65536;
    if (id === 0) continue;
    covered++;
    seen.add(id);
  }

  const visible = seen.size;
  return {
    submitted,
    visible,
    wasted: submitted > 0 ? Math.max(0, (submitted - visible) / submitted) : 0,
    covered,
  };
}
