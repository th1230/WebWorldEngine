#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { COOKER_VERSION, cookAll } from './pipeline.ts';

/**
 * 所有路徑都相對於**呼叫時的工作目錄**，不是這個檔案的位置。
 *
 * 這是一個會被裝到別人專案裡的 CLI —— 用 `import.meta.url` 往上推算
 * 「專案根目錄」在 `node_modules` 底下會指到完全不同的地方。
 */
const USAGE = `
ww-cook —— 把 glTF 烘焙成 @webworld/three 吃的格式

  ww-cook <來源目錄> [選項]

選項
  --out <目錄>   輸出目錄（預設 ./public/cooked）
  --verify       烘焙兩次並比對雜湊，驗證可重現性
  --builtins     一併產生內建的程序化資產（量測用的固定物）
  -h, --help     顯示這段

來源目錄裡的每個 .glb / .gltf 都會被烘焙。**每個 primitive 各自成為一個
mesh 資產** —— 繪製單位本來就是 primitive，不同材質必然是不同 draw。

輸出是 assets.manifest.json 加上一批 .wwm。載入方式：

  const rock = await WW.load('/cooked/assets.manifest.json', 'mesh:…');
`;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} 後面要接一個路徑`);
  }
  return value;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const builtins = argv.includes('--builtins');
  // 第一個不是旗標、也不是旗標參數的東西就是來源目錄。
  const flagged = new Set<string>();
  for (const name of ['--out', '--source']) {
    const at = argv.indexOf(name);
    if (at >= 0) flagged.add(argv[at + 1] ?? '');
  }
  const positional = argv.find((a) => !a.startsWith('--') && !flagged.has(a));

  const target = path.resolve(flagValue(argv, '--out') ?? path.join('public', 'cooked'));
  const sourceDir = positional ?? flagValue(argv, '--source');

  if (sourceDir === undefined && !builtins) {
    console.error('要烘焙什麼？給一個來源目錄，或加上 --builtins。\n');
    console.log(USAGE);
    return 1;
  }

  console.log(`cooker ${COOKER_VERSION}`);
  const started = Date.now();

  /**
   * 掃描來源目錄。
   *
   * **排序是必要的**：`readdirSync` 的順序在不同檔案系統上不保證一致，
   * 而 cook 必須可重現。順序影響 AssetId 的產生順序，進而影響 manifest
   * 的雜湊 —— 同一批輸入在兩台機器上得到不同的雜湊，快取就永遠是髒的。
   */
  const sourceFiles: Array<{
    name: string;
    bytes: Uint8Array;
    resources?: Map<string, Uint8Array>;
  }> = [];
  let glbCount = 0;
  let gltfCount = 0;
  if (sourceDir !== undefined) {
    if (!fs.existsSync(sourceDir)) {
      // 「找不到來源」不能靜靜地跑出一個空的 manifest —— 那看起來像
      // 「cook 成功但什麼都沒有」，而使用者會去找別的地方的問題。
      console.error(`找不到來源目錄：${path.resolve(sourceDir)}`);
      return 1;
    }
    for (const name of fs.readdirSync(sourceDir).sort()) {
      const full = path.join(sourceDir, name);
      if (name.endsWith('.glb')) {
        glbCount++;
        sourceFiles.push({ name, bytes: new Uint8Array(fs.readFileSync(full)) });
      } else if (name.endsWith('.gltf')) {
        gltfCount++;
        const bytes = new Uint8Array(fs.readFileSync(full));
        sourceFiles.push({ name, bytes, resources: readResources(bytes, sourceDir) });
      }
    }
  }
  if (sourceFiles.length > 0) {
    const parts = [
      glbCount > 0 ? `${glbCount} 個 .glb` : '',
      gltfCount > 0 ? `${gltfCount} 個 .gltf` : '',
    ]
      .filter(Boolean)
      .join('、');
    console.log(`來源資產：${parts}（${sourceDir}）`);
  }

  const options = { sourceFiles, builtins };
  const result = await cookAll(options);

  if (argv.includes('--verify')) {
    // 可重現：相同輸入必須得到相同雜湊。
    // 這裡在同一個行程內烘焙兩次，任何隱藏的狀態相依都會現形。
    const second = await cookAll(options);
    if (second.manifest.contentHash !== result.manifest.contentHash) {
      console.error('✗ 兩次烘焙的 manifest 雜湊不同 —— cook 不可重現');
      for (const id of Object.keys(result.manifest.meshes)) {
        const a = result.manifest.meshes[id]!.contentHash;
        const b = second.manifest.meshes[id]!.contentHash;
        if (a !== b) console.error(`    ${id}: ${a} ≠ ${b}`);
      }
      return 1;
    }
    console.log(`✓ 可重現：兩次烘焙的 manifest 雜湊皆為 ${result.manifest.contentHash}`);
  }

  fs.mkdirSync(target, { recursive: true });

  // 先刪掉這次不會產生的舊檔案。
  //
  // 不清理的話，改了檔名規則（例如加上格式變體後綴）就會留下一份仍在被
  // 提供的舊檔。那種殘留最惡劣的形式是：cook 其實失敗了，但瀏覽器載到舊檔
  // 所以「看起來正常」—— 於是你在除錯一個已經不存在的版本。
  const expected = new Set([...result.files.keys(), 'assets.manifest.json']);
  let removed = 0;
  for (const name of fs.readdirSync(target)) {
    if (expected.has(name)) continue;
    fs.rmSync(path.join(target, name), { force: true });
    removed++;
  }
  if (removed > 0) console.log(`清除 ${removed} 個不再產生的舊檔案`);

  for (const [name, bytes] of result.files) {
    fs.writeFileSync(path.join(target, name), bytes);
  }
  fs.writeFileSync(
    path.join(target, 'assets.manifest.json'),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    'utf8',
  );

  // 網格與貼圖分開統計。
  //
  // 把兩者加總卻標成「N 個 mesh 共 X KB」會讓「切線讓 mesh 變 2.7 倍」
  // 這種假結論看起來很有說服力（實際只有 +37%）。標籤錯了的統計比沒有
  // 統計更糟。
  let meshBytes = 0;
  for (const [name, bytes] of result.files) {
    if (name.endsWith('.wwm')) meshBytes += bytes.byteLength;
  }

  console.log(
    `\n${Object.keys(result.manifest.meshes).length} 個 mesh，共 ${(meshBytes / 1024).toFixed(1)} KB`,
  );
  console.log('場景                  來源三角形    LOD 鏈');
  for (const [id, stats] of Object.entries(result.manifest.stats)) {
    console.log(
      `  ${id.padEnd(20)}${String(stats.sourceTriangles).padStart(8)}    ${stats.lodTriangles.join(' → ')}`,
    );
  }

  const textures = Object.values(result.manifest.textures);
  if (textures.length > 0) {
    let compressed = 0;
    let raw = 0;
    for (const texture of textures) {
      compressed += texture.byteLength;
      raw += texture.uncompressedBytes;
    }
    console.log(
      `\n${textures.length} 張貼圖，${(compressed / 1024).toFixed(1)} KB` +
        `（未壓縮 ${(raw / 1024).toFixed(1)} KB，壓縮率 ${(raw / compressed).toFixed(1)}:1）`,
    );
    for (const texture of textures) {
      console.log(
        `  ${texture.id.padEnd(22)}${texture.width}×${texture.height}  ` +
          `${texture.levelCount} mip  vk${texture.vkFormat}  ${(texture.byteLength / 1024).toFixed(1)} KB`,
      );
    }
  }

  if (result.manifest.warnings.length > 0) {
    console.log('\n注意：');
    for (const warning of result.manifest.warnings) console.log(`  - ${warning}`);
  }

  console.log(`\n輸出：${target}`);
  console.log(`manifest hash：${result.manifest.contentHash}  (${Date.now() - started}ms)`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });

/**
 * 讀出一個 `.gltf` 引用的所有外部資源（`.bin` 與貼圖）。
 *
 * 分離形式的 glTF 把 buffer 與影像放在**旁邊的檔案**裡，URI 是相對於
 * `.gltf` 所在目錄的路徑。cooker 本身不碰檔案系統（那讓它同樣能在瀏覽器
 * 與測試裡跑），所以把檔案讀進來是 CLI 的責任。
 *
 * 缺檔不在這裡報錯 —— 匯入器會列出**缺了哪些**，那比「某個檔案讀不到」
 * 有用得多。這裡只負責把找得到的都帶上。
 */
function readResources(gltfBytes: Uint8Array, baseDir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let json: { buffers?: unknown[]; images?: unknown[] };
  try {
    json = JSON.parse(new TextDecoder().decode(gltfBytes)) as typeof json;
  } catch {
    return out;
  }

  for (const list of [json.buffers ?? [], json.images ?? []]) {
    for (const item of list) {
      const uri = (item as { uri?: unknown }).uri;
      if (typeof uri !== 'string' || uri.startsWith('data:')) continue;
      const relative = decodeURIComponent(uri);
      // 路徑穿越防護：URI 來自檔案內容，不該讓它讀到來源目錄之外。
      const full = path.resolve(baseDir, relative);
      if (!full.startsWith(path.resolve(baseDir))) continue;
      if (fs.existsSync(full)) out.set(relative, new Uint8Array(fs.readFileSync(full)));
    }
  }
  return out;
}
