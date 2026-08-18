import { BufferAttribute, DataTexture, FloatType, NearestFilter, RGBAFormat, Vector3 } from 'three';
import type { AnimationClip, BufferGeometry, SkinnedMesh } from 'three';

/**
 * 把一段骨骼動畫烘成一張**頂點位置貼圖**（VAT）。
 *
 * ## 為什麼需要它
 *
 * 骨骼蒙皮打掉這個引擎的核心假設：`BatchedMesh` 不支援蒙皮，所以批次、LOD 鏈、
 * 遠景合併對會動的東西全部無效。實測（`tools/gpu-check/skinned-scaling.mjs`）：
 *
 * | | |
 * | --- | ---: |
 * | 800 個蒙皮模型 | 7.566 ms，**740 次繪製**（一個 instance 一次，完全不批次） |
 * | 其中三角形那一側只值 | 1.02 ms |
 * | 每個 instance 的額外成本 | **8.2 µs** |
 * | 對照：靜態那條路 | 0.82 µs |
 *
 * **貴 10 倍，而且全部在逐 instance 那一側** —— 繪製呼叫與骨骼矩陣上傳。
 *
 * UE 遇到同樣的規模問題也是繞開的：把動畫烘成貼圖，在 vertex shader 裡取樣，
 * 於是會動的東西變回**靜態幾何**，整條批次／LOD／合併的路重新適用。
 *
 * ## 這個檔案只做烘焙，不做著色
 *
 * 烘焙是純 CPU、可以逐頂點驗證的；著色是 shader 注入，失效方式完全不同
 * （畫面錯但不報錯）。混在一起的話，出問題時分不出是哪一半。
 *
 * 所以這裡的產出是一張貼圖加一份幾何，而「怎麼用它」是另一件事。單獨看它
 * 也已經有用：拿到貼圖的人可以自己寫那段 shader。
 *
 * ## 為什麼是位置而不是骨骼矩陣
 *
 * 烘骨骼矩陣（每幀 N 根骨頭 × 一個矩陣）比烘頂點省很多空間，但 vertex shader
 * 仍然要做蒙皮運算（讀 4 根骨頭、4 個權重、加權混合）。烘頂點是**把那筆運算
 * 也一起烘掉**：shader 只剩一次貼圖取樣。
 *
 * 代價是貼圖大小 = 頂點數 × 幀數 × 16 bytes。所以幀數是呼叫端訂的 —— 那是
 * 一個「記憶體換運算」的取捨，而取捨屬於開發者。
 */

export interface BakedVertexAnimation {
  /**
   * 可以直接拿去畫的幾何：原本的 attribute，加上一個 `wwVertexId`。
   *
   * ## 為什麼需要那個 attribute 而不是用 `gl_VertexID`
   *
   * 這份幾何最後會被塞進 `BatchedMesh` 的共用頂點緩衝裡，而 `gl_VertexID`
   * 在那裡是**整個批次**的索引，不是這份幾何自己的第幾個頂點。用它去查貼圖
   * 會查到別的模型的位置 —— 而症狀是模型爆開成一團亂線，不是報錯。
   *
   * 所以編號在烘的時候就寫進 attribute，跟著幾何一起走。
   */
  geometry: BufferGeometry;
  /**
   * 位置貼圖。寬 = 頂點數，高 = 幀數，`RGBA32F`。
   *
   * 第 `f` 幀第 `v` 個頂點的位置在 texel `(v, f)` 的 RGB。A 目前是 1，留著是
   * 因為 WebGL 的 float 貼圖沒有三分量的通用格式。
   */
  texture: DataTexture;
  /** 烘了幾幀。 */
  frameCount: number;
  /** 這段動畫多長，秒。 */
  duration: number;
  /** 頂點數，也就是貼圖的寬。 */
  vertexCount: number;
}

export interface BakeOptions {
  /**
   * 烘幾幀。預設 32。
   *
   * 這是**記憶體換運算**的取捨，所以由呼叫端訂：貼圖大小 = 頂點數 × 幀數 ×
   * 16 bytes。一個 5,000 頂點的模型烘 32 幀是 2.5 MB，烘 128 幀是 10 MB。
   *
   * 幀數不夠時的症狀是動作變得一格一格的 —— 那**看得見**，而且是取樣率的
   * 問題不是 bug。取樣時做線性內插可以緩解，但緩解不了取樣定理。
   */
  frames?: number;
}

/**
 * 把 `mesh` 在 `clip` 上的每一幀，逐頂點算出位置，寫進一張貼圖。
 *
 * 用的是 Three 自己的 `applyBoneTransform` —— 也就是**與 GPU 蒙皮同一套規則**
 * 的 CPU 版。自己重寫一遍加權混合會得到「數學上也對、但與 Three 不一致」的
 * 結果，而那個差異在畫面上是細微的變形，不會報錯。
 */
export function bakeVertexAnimation(
  mesh: SkinnedMesh,
  clip: AnimationClip,
  options: BakeOptions = {},
): BakedVertexAnimation {
  const frames = Math.max(2, Math.floor(options.frames ?? 32));
  const position = mesh.geometry.getAttribute('position');
  if (position === undefined) {
    throw new Error('WW.bakeVertexAnimation: 幾何沒有 position attribute。');
  }
  if (mesh.skeleton === undefined || mesh.skeleton === null) {
    throw new Error(
      'WW.bakeVertexAnimation: 這個 SkinnedMesh 還沒有 bind 骨架。\n' +
        '先 mesh.bind(skeleton) 再烘 —— 沒有骨架的話烘出來的每一幀都是綁定姿勢，' +
        '而那看起來就只是「動畫沒有播」。',
    );
  }

  const vertexCount = position.count;
  const data = new Float32Array(vertexCount * frames * 4);
  const vertex = new Vector3();

  // 逐幀取樣。最後一幀落在 duration 上而不是 duration - step —— 循環動畫的
  // 頭尾應該接得起來，而取樣到 duration 正好等於取樣到 0。
  const duration = clip.duration;
  for (let f = 0; f < frames; f++) {
    const time = (f / (frames - 1)) * duration;
    applyClipAt(mesh, clip, time);

    for (let v = 0; v < vertexCount; v++) {
      vertex.fromBufferAttribute(position, v);
      // 這一行就是 GPU 蒙皮在做的事，只是在 CPU 上。
      mesh.applyBoneTransform(v, vertex);
      const at = (f * vertexCount + v) * 4;
      data[at] = vertex.x;
      data[at + 1] = vertex.y;
      data[at + 2] = vertex.z;
      data[at + 3] = 1;
    }
  }

  // 幾何本身不改（位置由 shader 從貼圖讀），只多掛一個頂點編號。
  const geometry = mesh.geometry.clone();
  const ids = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) ids[v] = v;
  geometry.setAttribute('wwVertexId', new BufferAttribute(ids, 1));
  // 蒙皮的 attribute 留著沒有意義 —— 位置已經烘進貼圖了，而它們每個頂點
  // 佔 12 bytes。更重要的是：留著會讓 `InstancedMesh` 警告「這個類別不會
  // 蒙皮」，而那句話在這裡是錯的（這條路本來就不靠蒙皮）。
  geometry.deleteAttribute('skinIndex');
  geometry.deleteAttribute('skinWeight');

  const texture = new DataTexture(data, vertexCount, frames, RGBAFormat, FloatType);
  // **不能用線性過濾。** 貼圖的一個維度是頂點編號，相鄰的兩個頂點在空間上
  // 沒有任何關係 —— 內插它們會把兩個不相干的頂點混在一起，而症狀是模型上
  // 出現隨機的尖刺。時間軸上的內插要在 shader 裡自己做（讀兩幀再混）。
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { geometry, texture, frameCount: frames, duration, vertexCount };
}

/**
 * 把 `clip` 在時間 `time` 的姿勢套到骨架上。
 *
 * 不用 `AnimationMixer`：它需要一個 update 迴圈與 delta 時間，而這裡要的是
 * 「直接跳到某個時間點」。直接讀軌道反而簡單，而且沒有累積誤差。
 */
function applyClipAt(mesh: SkinnedMesh, clip: AnimationClip, time: number): void {
  for (const track of clip.tracks) {
    // 軌道名稱長這樣：`BoneName.position` / `.quaternion` / `.scale`
    const dot = track.name.lastIndexOf('.');
    if (dot < 0) continue;
    const boneName = track.name.slice(0, dot).replace(/^\./, '');
    const property = track.name.slice(dot + 1);
    const bone = mesh.skeleton.getBoneByName(boneName);
    if (bone === undefined) continue;

    const values = sampleTrack(track, time);
    if (values === null) continue;
    if (property === 'position') bone.position.fromArray(values);
    else if (property === 'quaternion') bone.quaternion.fromArray(values);
    else if (property === 'scale') bone.scale.fromArray(values);
  }

  // 骨架的世界矩陣要重算，`applyBoneTransform` 讀的是 `boneMatrices`。
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
}

/**
 * 在 `time` 取樣一條軌道，回傳那一刻的值。
 *
 * 線性內插。四元數用 nlerp 而不是 slerp —— 相鄰兩個關鍵影格之間的夾角通常
 * 很小，兩者差異看不出來，而 nlerp 不必處理角度為零時的除法。
 */
function sampleTrack(
  track: { times: ArrayLike<number>; values: ArrayLike<number> },
  time: number,
): number[] | null {
  const times = track.times;
  const count = times.length;
  if (count === 0) return null;
  const stride = track.values.length / count;

  if (time <= times[0]!) return slice(track.values, 0, stride);
  if (time >= times[count - 1]!) return slice(track.values, count - 1, stride);

  let i = 1;
  while (i < count && times[i]! < time) i++;
  const t0 = times[i - 1]!;
  const t1 = times[i]!;
  const alpha = t1 === t0 ? 0 : (time - t0) / (t1 - t0);

  const a = slice(track.values, i - 1, stride);
  const b = slice(track.values, i, stride);
  const out = a.map((v, k) => v + (b[k]! - v) * alpha);

  if (stride === 4) {
    // 四元數混完要正規化，不然縮放會跟著跑掉。
    const length = Math.hypot(out[0]!, out[1]!, out[2]!, out[3]!);
    if (length > 0) for (let k = 0; k < 4; k++) out[k]! /= length;
  }
  return out;
}

function slice(values: ArrayLike<number>, index: number, stride: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < stride; k++) out.push(values[index * stride + k]!);
  return out;
}
