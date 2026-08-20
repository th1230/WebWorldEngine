import type { AssetManifest, TextureEntry } from "@webworld/format";
import {
  decodeTexture,
  validateTexture,
  type DecodedTexture,
} from "@ww/assets-runtime";
import {
  CompressedTexture,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  NoColorSpace,
  RED_GREEN_RGTC2_Format,
  RED_RGTC1_Format,
  RGBA_BPTC_Format,
  RGB_S3TC_DXT1_Format,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";
import {
  loadManifest,
  onClearAssetCache,
  pick,
  resolveAssetUrl,
} from "./manifest.ts";

/**
 * 載入 cook 過的貼圖與材質。
 *
 * ```js
 * const material = await WW.loadMaterial('/cooked/assets.manifest.json', 'material:rock');
 * scene.add(new WW.InstancedMesh(rock, material, 10000));
 * ```
 *
 * ## 為什麼回傳的是 `MeshStandardMaterial`
 *
 * 因為那正是不用這個套件時會自己寫的東西。回傳自訂的材質類別會讓所有
 * 既有的東西失效 —— 後處理、`material.onBeforeCompile`、換材質、
 * `MeshStandardMaterial` 的每一個屬性。這裡要換掉的只有「把 cook 過的
 * 貼圖接上去」那幾行，不是材質系統本身。
 *
 * ```diff
 * - const material = new THREE.MeshStandardMaterial({ map, normalMap, … });
 * + const material = await WW.loadMaterial(manifest, 'material:rock');
 * ```
 *
 * 拿到之後照樣可以改：`material.envMapIntensity = 0.6` 就是原本的那個屬性。
 *
 * ## 壓縮貼圖不是「比較小的 PNG」
 *
 * `.ktx2` 裡的 BC 資料是**直接餵給 GPU 的**：沒有解碼、沒有 `ImageBitmap`、
 * 沒有主執行緒上的一次完整像素展開。同一張 1024² 貼圖在 VRAM 裡也從
 * RGBA8 的 5.3 MB 降到 BC7 的 1.4 MB（BC1 是 0.7 MB）。
 *
 * 代價是格式要 GPU 支援。BC 系列在桌機是通用的，而這個引擎的範圍就是桌機
 * （見 `specs/roadmap.md` 的範圍宣告）—— 行動裝置要的 ETC2/ASTC 沒有產生。
 */

/**
 * 這台裝置支不支援 BC 系列的壓縮貼圖。**探測一次就記住。**
 *
 * ## 為什麼要問
 *
 * 不問的話，不支援的裝置會走到「把壓縮資料交給 GPU，GPU 拒絕」——
 * 而那條路上沒有人會丟例外：貼圖變黑或整個不見，材質看起來像沒接上，
 * 而錯誤訊息（如果有的話）在 renderer 深處。
 *
 * 桌機以外幾乎都不支援 BC（手機要的是 ETC2/ASTC），而 cooker 目前只產 BC
 * —— 那是**宣告過的範圍**，不是缺陷。但宣告過的範圍被踩到時要**大聲說**，
 * 不能靜靜壞掉。
 *
 * ## 為什麼用 WebGL2 的擴充當判準
 *
 * 它問得到、同步、而且不需要拿到使用者的 renderer。WebGPU 那一側要非同步
 * 查 adapter feature，而實務上桌機的 WebGPU 一定有 `texture-compression-bc`
 * —— 會缺的是行動裝置，而那裡 WebGL2 的擴充同樣會缺。**這是代理指標，
 * 不是保證**，所以訊息裡講的是「這台裝置看起來不支援」。
 */
let bcSupport: boolean | null = null;

function supportsBlockCompression(): boolean {
  if (bcSupport !== null) return bcSupport;
  if (typeof document === "undefined") return (bcSupport = true);
  const gl = document.createElement("canvas").getContext("webgl2");
  if (gl === null) return (bcSupport = true);
  bcSupport =
    gl.getExtension("WEBGL_compressed_texture_s3tc") !== null &&
    gl.getExtension("EXT_texture_compression_rgtc") !== null &&
    gl.getExtension("EXT_texture_compression_bptc") !== null;
  return bcSupport;
}

/** Vulkan 那一側的格式 → Three 的常數。 */
const THREE_FORMAT = {
  "bc1-rgb": RGB_S3TC_DXT1_Format,
  "bc1-rgb-srgb": RGB_S3TC_DXT1_Format,
  "bc4-r": RED_RGTC1_Format,
  "bc5-rg": RED_GREEN_RGTC2_Format,
  "bc7-rgba": RGBA_BPTC_Format,
  "bc7-rgba-srgb": RGBA_BPTC_Format,
} as const satisfies Record<DecodedTexture["format"], number>;

const textures = new Map<string, Promise<CompressedTexture>>();
const materials = new Map<string, Promise<MeshStandardMaterial>>();

/**
 * 清快取的時候要**真的釋放 GPU 記憶體**，不是只把 Map 清掉。
 *
 * Three 釋放貼圖的 VRAM 是靠 `dispose()`，不是靠垃圾回收 —— 只把參照丟掉
 * 的話 JS 這一側乾淨了，GPU 那一側那張貼圖還在，而且**永遠不會被收回**。
 *
 * 這在一次性的頁面看不出來，在串流的世界裡是無上限的洩漏：每載入一批新
 * 資產就多佔一份，而畫面完全正常，直到配置失敗為止。
 *
 * 而配置失敗正是這條軸量到的那道牆 —— 貼圖資料到 5.5 GB 幀時間一點都沒動，
 * 但再往上頁面就載不起來了（見 roadmap 的貼圖壓力那一節）。
 */
onClearAssetCache(() => {
  // ## 失敗的那些要吞掉，不然變成沒人接的 rejection
  //
  // 快取裡放的是 promise，而載失敗的那一筆是個已經 reject 的 promise。
  // 對它接 `.then` 會生出一個新的、同樣 reject 而且**沒人接**的 promise ——
  // 測試跑起來會出現 unhandled rejection，而那會讓整個 run 失敗即使每一條
  // 測試都過（實測 688 條全過但 exit code 非零）。
  //
  // 而且載失敗的東西本來就沒有 GPU 資源要放。
  for (const pending of textures.values())
    void pending.then((texture) => texture.dispose(), noop);
  for (const pending of materials.values())
    void pending.then((material) => material.dispose(), noop);
  textures.clear();
  materials.clear();
});

/** 失敗的載入沒有東西要放，接住就好。 */
function noop(): void {}

/**
 * 放掉單一一份材質與它的貼圖。
 *
 * ## 為什麼需要「單一一份」
 *
 * `clearAssetCache()` 是全部一起清 —— 串流的世界裡那等於「走遠一格就把
 * 整個世界的貼圖重新抓一次」。
 *
 * 串流的 `unload` 鉤子本來就讓呼叫端在格子卸載時釋放資源（那是刻意的
 * 分界：格子裡有什麼是內容的事）。缺的是**釋放得了**的手段。
 *
 * @returns 有沒有真的放掉。沒被快取過就回 false。
 */
export function releaseMaterial(manifestUrl: string, id: string): boolean {
  // ## 一個 id 可能有**好幾份**
  //
  // 快取的鍵帶著材質類別（同一個 id 用 `MeshStandardMaterial` 與
  // `MeshStandardNodeMaterial` 各要一份），所以放掉的時候要把那個 id 的
  // 每一種都放掉 —— 只放一種的話剩下那份還掛著貼圖，而貼圖才是大頭。
  const prefix = `${manifestUrl}#${id}#`;
  const keys = [...materials.keys()].filter((k) => k.startsWith(prefix));
  if (keys.length === 0) return false;
  for (const key of keys) {
    const pending = materials.get(key)!;
    materials.delete(key);
    void pending.then((material) => {
      // 貼圖也要放 —— 只放材質的話那幾張貼圖還掛在 GPU 上，而它們才是大頭。
      for (const slot of [
        material.map,
        material.normalMap,
        material.roughnessMap,
        material.metalnessMap,
      ]) {
        if (slot === null) continue;
        const url = (slot as { userData?: { wwUrl?: string } }).userData?.wwUrl;
        if (url !== undefined) textures.delete(url);
        slot.dispose();
      }
      material.dispose();
    }, noop);
  }
  return true;
}

/**
 * 載入單張 cook 過的貼圖。
 *
 * 同一個 URL 只會抓一次，而且**回傳的是同一個 `Texture` 實例** —— 十個材質
 * 共用一張貼圖時，GPU 上就是一份。各自建一個 `Texture` 包同一份位元組的話，
 * Three 會依實例上傳，VRAM 直接乘以十。
 *
 * 所以不要對回傳值呼叫 `dispose()`，除非確定沒有別的東西在用它。要整批放掉
 * 用 `clearAssetCache()`。
 */
export async function loadTexture(
  manifestUrl: string,
  textureId: string,
): Promise<Texture> {
  const base = resolveAssetUrl(manifestUrl);
  const manifest = await loadManifest(base);
  const entry = pick(manifest.textures, textureId, "貼圖", manifestUrl);

  const url = resolveAssetUrl(entry.file, base);
  const cached = textures.get(url);
  if (cached !== undefined) return cached;

  const pending = fetchTexture(url, entry, textureId);
  textures.set(url, pending);
  return pending;
}

/**
 * 載入 cook 過的材質，貼圖一併接好。
 *
 * 第二個參數可以是材質 id，也可以是**網格 id** —— 網格知道自己該用哪個
 * 材質，所以常見的情況一行就夠：
 *
 * ```js
 * const rock = await WW.load(manifest, 'mesh:rock-large');
 * const material = await WW.loadMaterial(manifest, 'mesh:rock-large');
 * ```
 *
 * 兩者不會混淆：一個 key 要嘛在 `materials` 裡、要嘛在 `meshes` 裡。
 *
 * 缺哪一張貼圖就不接哪一張 —— cook 時沒有法線貼圖的材質拿到的就是一個
 * 沒有 `normalMap` 的 `MeshStandardMaterial`，不是錯誤。
 */
/**
 * 要建哪一種材質。
 *
 * ## 為什麼要開這個口
 *
 * 預設回傳 `MeshStandardMaterial` —— 那正是不用這個套件時會自己寫的東西。
 *
 * 但在 WebGPU 上它**不是 node 材質**（換掉是 `WebGPURenderer` 內部做的，
 * 呼叫端手上那個物件的 `isNodeMaterial` 一直是 false）。而套件裡凡是往
 * 呼叫端的材質上加東西的功能 —— 間接光、頂點動畫、換階淡入、虛擬貼圖 ——
 * 在 node 那條路上都只加得上 node 材質。
 *
 * 沒有這個口的話，照文件走的人一用 `loadMaterial` 就再也接不上那四個。
 * 而症狀是靜靜地什麼都沒發生（套件會在主控台講，但那已經是繞了一圈）。
 *
 * ```js
 * import { MeshStandardNodeMaterial } from 'three/webgpu';
 * const material = await WW.loadMaterial(url, id, { MaterialClass: MeshStandardNodeMaterial });
 * ```
 */
export interface LoadMaterialOptions {
  /** 預設 `MeshStandardMaterial`。WebGPU 上給 `MeshStandardNodeMaterial`。 */
  MaterialClass?: new (params?: {
    roughness?: number;
    metalness?: number;
  }) => MeshStandardMaterial;
}

export async function loadMaterial(
  manifestUrl: string,
  id: string,
  options: LoadMaterialOptions = {},
): Promise<MeshStandardMaterial> {
  const base = resolveAssetUrl(manifestUrl);
  const manifest = await loadManifest(base);

  const materialId = resolveMaterialId(manifest, id, manifestUrl);
  const entry = pick(manifest.materials, materialId, "材質", manifestUrl);

  // ## 快取的鍵要帶上材質類別
  //
  // 同一個 id 用兩種類別各要一份。不帶的話第二次會拿到第一次那個 ——
  // 而症狀是「WebGPU 上那些功能接不上」，也就是這個參數本來要解決的事。
  const MaterialClass = options.MaterialClass ?? MeshStandardMaterial;
  const key = `${base}#${materialId}#${MaterialClass.name}`;
  const cached = materials.get(key);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<MeshStandardMaterial> => {
    const [map, normalMap, ormMap] = await Promise.all([
      entry.baseColorTexture === null
        ? null
        : loadTexture(manifestUrl, entry.baseColorTexture),
      entry.normalTexture === null
        ? null
        : loadTexture(manifestUrl, entry.normalTexture),
      entry.roughnessAoTexture === null
        ? null
        : loadTexture(manifestUrl, entry.roughnessAoTexture),
    ]);

    const material = new MaterialClass({
      roughness: entry.roughness,
      metalness: entry.metalness,
    });
    // baseColor 是**線性**的（glTF 這樣定義）。走 `new Color(r, g, b)` 會被
    // 當成 sRGB 再轉一次，顏色整體偏暗，而且暗得很像「燈光沒調好」。
    material.color.setRGB(
      entry.baseColor[0],
      entry.baseColor[1],
      entry.baseColor[2],
    );
    // baseColor 的 alpha 目前只在完全不透明時才是有效的 —— cook 丟棄
    // alphaMode，透明度沒有被匯入（見 gltf-import.ts 的 ImportWarning）。
    if (map !== null) material.map = map;
    if (normalMap !== null) material.normalMap = normalMap;
    if (ormMap !== null) {
      // 同一張貼圖餵給兩個插槽：Three 的 `aoMap` 取 `.r`、`roughnessMap` 取
      // `.g`，剛好是 cook 時寫進去的兩個通道。兩張分開存等於為完全一樣的
      // 位元組付兩次頻寬。
      material.aoMap = ormMap;
      material.roughnessMap = ormMap;
    }
    return material;
  })();

  materials.set(key, pending);
  return pending;
}

/** 網格 id → 它的材質 id；本來就是材質 id 的話原樣回傳。 */
function resolveMaterialId(
  manifest: AssetManifest,
  id: string,
  manifestUrl: string,
): string {
  if (manifest.materials?.[id] !== undefined) return id;

  const mesh = manifest.meshes?.[id];
  if (mesh === undefined) return id; // 交給 pick 去報「有哪些可以選」

  if (mesh.material === null) {
    // cook 時就沒有材質。回傳一個預設的 `MeshStandardMaterial` 會讓白模看
    // 起來像正常結果 —— 說出來，讓呼叫端自己決定要用什麼。
    throw new Error(
      `WW.loadMaterial: ${manifestUrl} 裡的 "${id}" 沒有材質。\n` +
        "（來源檔沒有指定材質，或它是程序化資產）",
    );
  }
  return mesh.material;
}

async function fetchTexture(
  url: string,
  entry: TextureEntry,
  textureId: string,
): Promise<CompressedTexture> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WW.loadTexture: 抓不到 ${url}（HTTP ${response.status}）`);
  }
  const decoded = decodeTexture(
    new Uint8Array(await response.arrayBuffer()),
    entry,
  );

  // 解碼成功不等於資料是對的。尺寸與 mip 數對不上時，畫面會出現一張
  // 「看起來只是比較模糊」的貼圖 —— 那種錯誤不會有人回報。
  const problems = validateTexture(decoded, textureId);
  if (problems.length > 0) {
    throw new Error(
      `WW.loadTexture: ${textureId} 的資料不一致\n  ${problems.join("\n  ")}`,
    );
  }

  if (!supportsBlockCompression()) {
    throw new Error(
      [
        "WW.loadTexture: 這台裝置看起來不支援 BC 壓縮貼圖（" +
          textureId +
          " 是 " +
          decoded.format +
          "）。",
        "cook 目前只產 BC 系列，那是宣告過的範圍：桌機。行動裝置要的 ETC2/ASTC 還沒有產生。",
        "在那之前，這些裝置上請走未壓縮的貼圖路徑（自己 load 一張 PNG 給 material）——",
        "其餘的 LOD、剔除、串流完全不受影響。",
      ].join("\n"),
    );
  }

  const texture = new CompressedTexture(
    decoded.levels.map((level) => ({
      data: level.data,
      width: level.width,
      height: level.height,
    })),
    decoded.width,
    decoded.height,
    THREE_FORMAT[decoded.format],
  );
  // 色彩貼圖是 sRGB，法線與 ORM 是**資料**。搞混的話畫面不會壞，只會
  // 「顏色就是不太對」—— 而那查起來會查到材質、燈光、色調映射去。
  texture.colorSpace = decoded.srgb ? SRGBColorSpace : NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  // mip 是 cook 時算好的，這裡只要讓 GPU 用它們。少了這一行，遠處的貼圖
  // 會直接在最高階上取樣，走動時整片閃爍。
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  // 貼上自己的 URL，這樣 `releaseMaterial` 才知道該從快取裡刪哪一筆。
  // 不貼的話它只 dispose 得掉 GPU 那一份，Map 裡會留著一個指向已釋放貼圖的
  // 空殼 —— 下次要用同一張時拿到它，畫面上是黑的，而且不報錯。
  //
  // 貼在**這裡**而不是快取那一行：在那邊要多接一層 `.then`，而多一層會讓
  // 失敗路徑上的 rejection 多一個沒人接的分支（實測跑出 unhandled rejection）。
  texture.userData.wwUrl = url;
  return texture;
}
