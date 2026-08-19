import * as THREE from 'three';

/**
 * 一堆**各自不同**的貼圖，用來問「貼圖資料超過 VRAM 的時候會怎樣」。
 *
 * ## 為什麼要這個場景
 *
 * 虛擬貼圖是唯一一項現在的示範內容量不了的（見 roadmap）。而 doctrine 第 12
 * 條說：內容不夠大的時候，量到的是「這台機器不在乎」，不是「這個功能沒用」。
 *
 * 所以第一步不是寫虛擬貼圖，是**先看今天會怎樣**：
 *
 * - 掉幀？當掉？還是驅動自己換頁換得還可以？
 * - 記憶體到哪個量級開始出事？
 *
 * 沒有這個數字的話，虛擬貼圖做完也不知道它省了什麼。
 *
 * ## 為什麼用程序生成的貼圖
 *
 * 「一百棟各自獨特貼圖的建築」那種資產這裡沒有，而做出來是一個大工程。
 * 程序生成的貼圖在**記憶體與頻寬**上與真的沒有差別 —— 而這條軸問的正是
 * 記憶體與頻寬，不是好不好看。
 *
 * 它不能代表的是「真實資產的 mip 分佈與重複使用率」，所以這個場景只用來
 * 回答「現在會怎樣」，不用來宣稱虛擬貼圖能省多少。
 */

export interface TextureHeavyScene {
  root: THREE.Group;
  /** 產生了幾張貼圖。 */
  textures: number;
  /** 這些貼圖佔多少 MB（RGBA8，含 mip）。 */
  megabytes: number;
  dispose: () => void;
}

/**
 * 造一張獨一無二的貼圖。
 *
 * 內容要**真的不一樣** —— 全部一樣的話驅動可能會去重，而那會讓這個場景
 * 量到一個假的好結果。
 */
function uniqueTexture(size: number, seed: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let state = (seed * 2654435761) >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = (i / size) | 0;
    // 有結構又有雜訊：純雜訊壓不動，純漸層又太規律。
    const base = Math.sin((x + seed) * 0.05) * Math.cos((y + seed) * 0.07) * 0.5 + 0.5;
    const noise = next() * 0.35;
    data[i * 4] = Math.min(255, (base * 200 + noise * 255) | 0);
    data[i * 4 + 1] = Math.min(255, (base * 160 + noise * 200) | 0);
    data[i * 4 + 2] = Math.min(255, (base * 120 + noise * 160) | 0);
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * @param count 幾張獨立貼圖。
 * @param size 每張的邊長。
 * @param stack `true` 的話拼成一片剛好鋪滿畫面的磁磚。
 *
 * ## 為什麼要有兩種擺法，而且第二種改過一次
 *
 * 攤成一片從遠處看的話，每個方塊在螢幕上只有幾像素 —— 取樣到的只有最小的
 * 那幾層 mip，**實際用到的資料遠小於總量**。那種情況驅動輕鬆應付（實測到
 * 10.9 GB 都沒事），但它回答的不是虛擬貼圖要解的問題。
 *
 * 虛擬貼圖要解的是**工作集**超過 VRAM。第一版的做法是把大板子疊成一疊，
 * 每一張都鋪滿畫面 —— 而那量到的是**overdraw**：1024 張半透明的全螢幕板子
 * 就是 1024 倍的填充，GPU 時間跟著填充走，跟貼圖住在哪裡沒有關係。
 *
 * 現在的做法是**拼磁磚**：N 張各佔畫面的 1/N，加起來剛好鋪滿一次。填充固定
 * 是一個畫面，變的只有貼圖總量 —— 那才隔離得出貼圖的壓力。
 */
export function makeTextureHeavy(count: number, size: number, stack = false): TextureHeavyScene {
  const root = new THREE.Group();
  // 拼磁磚時每一塊的大小由數量決定，下面算。
  const side = Math.max(1, Math.round(Math.sqrt(count)));
  const geometry = stack
    ? new THREE.PlaneGeometry(120 / side, 120 / side)
    : new THREE.BoxGeometry(6, 6, 6);
  const created: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];

  const perTexture = (size * size * 4 * 4) / 3 / 1048576; // RGBA8 + mip 鏈約 4/3

  for (let i = 0; i < count; i++) {
    const texture = uniqueTexture(size, i + 1);
    created.push(texture);
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 });
    materials.push(material);

    const mesh = new THREE.Mesh(geometry, material);
    if (stack) {
      // 拼成一片：N 張各佔 1/N，加起來剛好一個畫面。**沒有重疊**，所以
      // 填充是固定的，變的只有貼圖總量。
      const tile = 120 / side;
      const x = ((i % side) - (side - 1) / 2) * tile;
      const y = (((i / side) | 0) - (side - 1) / 2) * tile;
      mesh.position.set(x, y, 0);
    } else {
      const gridSide = Math.ceil(Math.sqrt(count));
      const x = (i % gridSide) - gridSide / 2;
      const z = ((i / gridSide) | 0) - gridSide / 2;
      mesh.position.set(x * 9, 0, z * 9);
    }
    root.add(mesh);
  }

  return {
    root,
    textures: count,
    megabytes: +(perTexture * count).toFixed(1),
    dispose: () => {
      for (const texture of created) texture.dispose();
      for (const material of materials) material.dispose();
      geometry.dispose();
    },
  };
}
