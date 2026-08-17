import type { AssetManifest, TextureEntry } from '@webworld/format';
import { decodeTexture, validateTexture, type DecodedTexture } from '@ww/assets-runtime';
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
} from 'three';
import { loadManifest, onClearAssetCache, pick, resolveAssetUrl } from './manifest.ts';

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

/** Vulkan 那一側的格式 → Three 的常數。 */
const THREE_FORMAT = {
  'bc1-rgb': RGB_S3TC_DXT1_Format,
  'bc1-rgb-srgb': RGB_S3TC_DXT1_Format,
  'bc4-r': RED_RGTC1_Format,
  'bc5-rg': RED_GREEN_RGTC2_Format,
  'bc7-rgba': RGBA_BPTC_Format,
  'bc7-rgba-srgb': RGBA_BPTC_Format,
} as const satisfies Record<DecodedTexture['format'], number>;

const textures = new Map<string, Promise<CompressedTexture>>();
const materials = new Map<string, Promise<MeshStandardMaterial>>();
onClearAssetCache(() => {
  textures.clear();
  materials.clear();
});

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
export async function loadTexture(manifestUrl: string, textureId: string): Promise<Texture> {
  const base = resolveAssetUrl(manifestUrl);
  const manifest = await loadManifest(base);
  const entry = pick(manifest.textures, textureId, '貼圖', manifestUrl);

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
export async function loadMaterial(
  manifestUrl: string,
  id: string,
): Promise<MeshStandardMaterial> {
  const base = resolveAssetUrl(manifestUrl);
  const manifest = await loadManifest(base);

  const materialId = resolveMaterialId(manifest, id, manifestUrl);
  const entry = pick(manifest.materials, materialId, '材質', manifestUrl);

  const key = `${base}#${materialId}`;
  const cached = materials.get(key);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<MeshStandardMaterial> => {
    const [map, normalMap, ormMap] = await Promise.all([
      entry.baseColorTexture === null ? null : loadTexture(manifestUrl, entry.baseColorTexture),
      entry.normalTexture === null ? null : loadTexture(manifestUrl, entry.normalTexture),
      entry.roughnessAoTexture === null ? null : loadTexture(manifestUrl, entry.roughnessAoTexture),
    ]);

    const material = new MeshStandardMaterial({
      roughness: entry.roughness,
      metalness: entry.metalness,
    });
    // baseColor 是**線性**的（glTF 這樣定義）。走 `new Color(r, g, b)` 會被
    // 當成 sRGB 再轉一次，顏色整體偏暗，而且暗得很像「燈光沒調好」。
    material.color.setRGB(entry.baseColor[0], entry.baseColor[1], entry.baseColor[2]);
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
function resolveMaterialId(manifest: AssetManifest, id: string, manifestUrl: string): string {
  if (manifest.materials?.[id] !== undefined) return id;

  const mesh = manifest.meshes?.[id];
  if (mesh === undefined) return id; // 交給 pick 去報「有哪些可以選」

  if (mesh.material === null) {
    // cook 時就沒有材質。回傳一個預設的 `MeshStandardMaterial` 會讓白模看
    // 起來像正常結果 —— 說出來，讓呼叫端自己決定要用什麼。
    throw new Error(
      `WW.loadMaterial: ${manifestUrl} 裡的 "${id}" 沒有材質。\n` +
        '（來源檔沒有指定材質，或它是程序化資產）',
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
  const decoded = decodeTexture(new Uint8Array(await response.arrayBuffer()), entry);

  // 解碼成功不等於資料是對的。尺寸與 mip 數對不上時，畫面會出現一張
  // 「看起來只是比較模糊」的貼圖 —— 那種錯誤不會有人回報。
  const problems = validateTexture(decoded, textureId);
  if (problems.length > 0) {
    throw new Error(`WW.loadTexture: ${textureId} 的資料不一致\n  ${problems.join('\n  ')}`);
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
  return texture;
}
