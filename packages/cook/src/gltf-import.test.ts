import { Document, NodeIO } from '@gltf-transform/core';
import { VERTEX_FLOATS } from '@webworld/format';
import { describe, expect, it } from 'vitest';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { importGltf } from './gltf-import.ts';
import { cookAll } from './pipeline.ts';

/**
 * 真實 `.glb` 與程序化來源長得完全不同。這一組把那些差異逐一釘住 ——
 * 全部用 `@gltf-transform/core` 當場構造，**不需要任何美術檔**。
 *
 * 重點是這些情況錯了都**不會報錯**，只會靜默給出錯誤的幾何：
 * 模型少一半、位置差十倍、大小差三萬倍。那種錯誤看起來像「引擎有問題」。
 */

const TRI = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const IDX = new Uint32Array([0, 1, 2]);

interface BuildOptions {
  primitives?: number;
  materials?: boolean;
  scale?: [number, number, number];
  translation?: [number, number, number];
  normals?: boolean;
  quantized?: boolean;
}

async function build(options: BuildOptions = {}): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('obj');

  for (let i = 0; i < (options.primitives ?? 1); i++) {
    const primitive = doc.createPrimitive();
    if (options.quantized === true) {
      primitive.setAttribute(
        'POSITION',
        doc
          .createAccessor()
          .setType('VEC3')
          .setArray(new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0]))
          .setNormalized(true)
          .setBuffer(buffer),
      );
    } else {
      primitive.setAttribute(
        'POSITION',
        doc.createAccessor().setType('VEC3').setArray(TRI).setBuffer(buffer),
      );
    }
    primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(IDX).setBuffer(buffer));

    if (options.normals === true) {
      primitive.setAttribute(
        'NORMAL',
        doc
          .createAccessor()
          .setType('VEC3')
          .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]))
          .setBuffer(buffer),
      );
    }
    if (options.materials === true) {
      primitive.setMaterial(
        doc
          .createMaterial(`mat${i}`)
          .setBaseColorFactor([i / 10, 0.5, 0.25, 1])
          .setRoughnessFactor(0.4 + i / 10)
          .setMetallicFactor(0.1),
      );
    }
    mesh.addPrimitive(primitive);
  }

  const node = doc.createNode('n').setMesh(mesh);
  if (options.scale !== undefined) node.setScale(options.scale);
  if (options.translation !== undefined) node.setTranslation(options.translation);
  doc.createScene().addChild(node);

  return new NodeIO().writeBinary(doc);
}

describe('importGltf', () => {
  it('imports every primitive, not just the first', async () => {
    // 真實 .glb 幾乎一定是多 primitive（每個材質一個）。
    // 只取第一個的症狀是「模型少了一半」，而使用者會先懷疑匯出設定。
    const primitives = (await importGltf(await build({ primitives: 4 }), 'test.glb')).primitives;
    expect(primitives).toHaveLength(4);
    expect(new Set(primitives.map((p) => p.name)).size).toBe(4);
  });

  it('carries each primitive material separately', async () => {
    const primitives = (await importGltf(await build({ primitives: 3, materials: true }), 'test.glb')).primitives;
    expect(primitives.map((p) => p.material?.name)).toEqual(['mat0', 'mat1', 'mat2']);
    expect(primitives[1]!.material!.roughness).toBeCloseTo(0.5, 5);
    expect(primitives[2]!.material!.baseColor[0]).toBeCloseTo(0.2, 5);
  });

  it('applies the node world matrix', async () => {
    // 忽略節點變換的症狀是「模型位置/大小/朝向完全不對」，而且沒有錯誤。
    // Blender 匯出幾乎一定帶節點變換。
    const primitives = (await importGltf(
      await build({ scale: [10, 10, 10], translation: [5, 0, 0] }),
      'test.glb',
    )).primitives;
    // 頂點 1 是 (1,0,0)：×10 之後 +5 → (15,0,0)
    expect(primitives[0]!.mesh.vertices[VERTEX_FLOATS]).toBeCloseTo(15, 4);
  });

  it('leaves geometry untouched under an identity transform', async () => {
    // 沒有變換時就不該碰資料。多餘的矩陣乘法與正規化會引入浮點漂移，
    // 讓「來源帶了就沿用」的保證變成「幾乎沿用」。
    const primitives = (await importGltf(await build(), 'test.glb')).primitives;
    expect(primitives[0]!.mesh.vertices[VERTEX_FLOATS]).toBe(1);
  });

  it('de-normalizes quantized attributes', async () => {
    // gltfpack 的預設輸出就是量化的。用 getArray() 讀會拿到原始 Int16
    // （32767），當浮點數用就是幾何大了三萬倍。
    const primitives = (await importGltf(await build({ quantized: true }), 'test.glb')).primitives;
    expect(primitives[0]!.mesh.vertices[VERTEX_FLOATS]).toBeCloseTo(1, 4);
  });

  it('reports whether the source had normals', async () => {
    // cooker 依這個旗標決定要不要重算。分不出「沒給」與「給了全零」的話，
    // 美術刻意設定的硬邊法線會被靜默抹掉。
    const without = (await importGltf(await build(), 'test.glb')).primitives;
    expect(without[0]!.mesh.hasNormals).toBe(false);

    const with_ = (await importGltf(await build({ normals: true }), 'test.glb')).primitives;
    expect(with_[0]!.mesh.hasNormals).toBe(true);
  });

  it('throws when there is nothing usable', async () => {
    const doc = new Document();
    doc.createScene().addChild(doc.createNode('empty'));
    await expect(importGltf(await new NodeIO().writeBinary(doc), 'empty.glb')).rejects.toThrow(
      /沒有任何可用的 primitive/,
    );
  });
});

describe('cookAll with real source files', () => {
  it('cooks every primitive into its own mesh asset', async () => {
    const bytes = await build({ primitives: 3, materials: true });
    const { manifest, files } = await cookAll({
      builtins: true,
      textureSize: 16,
      collision: false,
      sourceFiles: [{ name: 'props.glb', bytes }],
    });

    const imported = Object.keys(manifest.meshes).filter((id) => id.includes('props.glb'));
    expect(imported).toHaveLength(3);
    for (const id of imported) {
      expect(files.has(manifest.meshes[id]!.file)).toBe(true);
      // cooker 產生的切線必須真的寫進去
      expect(manifest.meshes[id]!.lods[0]!.vertices.length % (VERTEX_FLOATS * 4)).toBe(0);
    }
  });

  it('registers the materials the primitives referenced', async () => {
    const bytes = await build({ primitives: 2, materials: true });
    const { manifest } = await cookAll({
      builtins: true,
      textureSize: 16,
      collision: false,
      sourceFiles: [{ name: 'props.glb', bytes }],
    });

    /**
     * 材質 AssetId 是 `material:<來源檔名>:<文件內索引>_<名稱>`。
     *
     * 三個部分都是必要的：
     *
     * - **檔名**：兩個檔案都有 `Material.001` 時不能互相覆蓋
     * - **索引**：真實匯出器常常不寫材質名（Sponza 的 25 個材質全部無名），
     *   只靠名字會把它們全部併成一個 —— 實測 69 張貼圖因此只進來 9 張
     * - **名稱**：有名字時保留，讓 AssetId 還讀得懂
     */
    const ids = Object.keys(manifest.materials).filter((id) => id.includes('props.glb'));
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => id.startsWith('material:props.glb:'))).toBe(true);
    // 程序化資產的材質不能被覆蓋掉
    expect(manifest.materials['material:rock']).toBeDefined();
  });

  it('keeps unnamed materials separate', async () => {
    // Sponza 的 25 個材質全部無名。以名字為鍵會把它們併成 1 個，
    // 而 cook 完全不會報錯 —— 只是 69 張貼圖裡有 60 張沒被匯入。
    const doc = new Document();
    const buffer = doc.createBuffer();
    const mesh = doc.createMesh('m');
    for (let i = 0; i < 4; i++) {
      const primitive = doc.createPrimitive().setMaterial(
        // 刻意不給名字
        doc.createMaterial().setRoughnessFactor(0.1 * i),
      );
      primitive.setAttribute(
        'POSITION',
        doc.createAccessor().setType('VEC3').setArray(TRI).setBuffer(buffer),
      );
      primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(IDX).setBuffer(buffer));
      mesh.addPrimitive(primitive);
    }
    doc.createNode('n').setMesh(mesh);
    doc.createScene('s');

    const { manifest } = await cookAll({
      builtins: true,
      textureSize: 16,
      collision: false,
      sourceFiles: [{ name: 'unnamed.glb', bytes: await new NodeIO().writeBinary(doc) }],
    });

    const ids = Object.keys(manifest.materials).filter((id) => id.includes('unnamed.glb'));
    expect(ids).toHaveLength(4);
  });

  it('warns instead of failing the whole cook when one file is broken', async () => {
    // 一個檔案壞掉不該讓整輪 cook 失敗，但**絕不能靜默跳過** ——
    // 那會表現成「某個模型就是不出現」而沒有任何線索。
    const { manifest } = await cookAll({
      builtins: true,
      textureSize: 16,
      collision: false,
      sourceFiles: [{ name: 'broken.glb', bytes: new Uint8Array([1, 2, 3, 4]) }],
    });
    expect(manifest.warnings.join()).toContain('broken.glb');
    // 其餘資產照樣產出
    expect(Object.keys(manifest.meshes).length).toBeGreaterThan(0);
  });

  it('stays reproducible with real source files', async () => {
    const bytes = await build({ primitives: 2, materials: true });
    const options = {
      textureSize: 16,
      collision: false,
      sourceFiles: [{ name: 'props.glb', bytes }],
    };
    const a = await cookAll(options);
    const b = await cookAll(options);
    expect(a.manifest.contentHash).toBe(b.manifest.contentHash);
  });
});

/**
 * 匯入器丟掉東西時必須說出來。
 *
 * 這一組的起因是實測：把 10 個 Khronos 官方測試資產餵進管線，
 * **全部烘焙成功、零警告**，而骨骼權重、morph target、頂點色與所有材質
 * 貼圖都被靜默丟棄。`BrainStem` 這個骨骼動畫角色烘成 59 個 primitive，
 * 永遠停在 bind pose —— manifest 看起來完全正常。
 *
 * 支援那些功能是各自獨立的工作。**「沒支援」與「沒說」是兩件事**，
 * 而這組測試釘住的是後者 —— 它最容易在後續重構時靜靜消失，
 * 因為刪掉一個警告不會讓任何東西壞掉。
 */
describe('importGltf 的丟棄警告', () => {
  it('reports dropped skinning attributes', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const primitive = doc.createPrimitive();
    primitive.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(TRI).setBuffer(buffer),
    );
    primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(IDX).setBuffer(buffer));
    primitive.setAttribute(
      'JOINTS_0',
      doc
        .createAccessor()
        .setType('VEC4')
        .setArray(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
        .setBuffer(buffer),
    );
    doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(primitive));
    doc.createScene('s');

    const result = await importGltf(await new NodeIO().writeBinary(doc), 'skinned.glb');
    expect(result.primitives).toHaveLength(1);
    const joints = result.warnings.find((w) => w.dropped === 'JOINTS_0');
    expect(joints).toBeDefined();
    // 警告必須說出**後果**。只寫「丟棄 JOINTS_0」的話，讀的人得自己知道
    // 那代表什麼 —— 而會讀到這行的人通常正是還不知道的那個。
    expect(joints!.effect).toMatch(/bind pose/);
  });

  it('carries material textures through instead of dropping them', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const texture = doc.createTexture('t').setImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const material = doc.createMaterial('m').setBaseColorTexture(texture);
    const primitive = doc.createPrimitive().setMaterial(material);
    primitive.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(TRI).setBuffer(buffer),
    );
    primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(IDX).setBuffer(buffer));
    doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(primitive));
    doc.createScene('s');

    const result = await importGltf(await new NodeIO().writeBinary(doc), 'textured.glb');
    const imported = result.primitives[0]!.material!;
    // 貼圖的位元組要原封不動帶出來，解碼是 cook 管線的事 ——
    // 匯入器碰 sharp（原生模組）的話，任何 import 這個套件的地方都要付代價。
    expect(imported.textures.baseColor).not.toBeNull();
    expect(imported.textures.baseColor!.bytes.length).toBeGreaterThan(0);
    // 而且不能再報成「丟棄」—— 那個警告現在是錯的資訊，比沒有更糟
    expect(result.warnings.some((w) => w.dropped === 'baseColorTexture')).toBe(false);
  });

  it('reports each kind of loss only once per file', async () => {
    // BrainStem 有 59 個 primitive。每個都報一行 JOINTS_0 的話，
    // 訊息會長到沒有人讀 —— 而讀不到的警告等於沒有警告。
    const doc = new Document();
    const buffer = doc.createBuffer();
    const mesh = doc.createMesh('m');
    for (let i = 0; i < 8; i++) {
      const primitive = doc.createPrimitive();
      primitive.setAttribute(
        'POSITION',
        doc.createAccessor().setType('VEC3').setArray(TRI).setBuffer(buffer),
      );
      primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(IDX).setBuffer(buffer));
      primitive.setAttribute(
        'COLOR_0',
        doc
          .createAccessor()
          .setType('VEC3')
          .setArray(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]))
          .setBuffer(buffer),
      );
      mesh.addPrimitive(primitive);
    }
    doc.createNode('n').setMesh(mesh);
    doc.createScene('s');

    const result = await importGltf(await new NodeIO().writeBinary(doc), 'many.glb');
    expect(result.primitives).toHaveLength(8);
    expect(result.warnings.filter((w) => w.dropped === 'COLOR_0')).toHaveLength(1);
  });

  it('says nothing when nothing was dropped', async () => {
    // 沒有丟棄卻報警告，會讓人學會忽略這一段輸出 —— 那比不報還糟。
    const result = await importGltf(await build(), 'clean.glb');
    expect(result.warnings).toEqual([]);
  });
});

/**
 * 「整個檔案打不開」等級的缺口。
 *
 * 實測 Khronos 官方語料 118 個 `.glb`，原本只能開 98 個 —— 剩下 20 個
 * 不是資料被丟掉，是**檔案讀不進來**。兩個獨立的原因：
 *
 * 1. 沒註冊任何 glTF 擴充 → 凡是把擴充列為 required 的檔案直接拋錯
 * 2. 非索引幾何被當成「不支援」跳過 → 只有一個 primitive 的檔案整個失敗
 *
 * 這兩項的共通點是**症狀完全指不回原因**：Draco 的錯誤訊息是
 * `Cannot read properties of undefined (reading 'DT_FLOAT32')`。
 */
describe('importGltf 的檔案相容性', () => {
  it('imports non-indexed geometry by generating indices', async () => {
    // 完全合法的 glTF：頂點依序三個一組。原本直接跳過，於是 Fox.glb
    // （只有一個 primitive）整個檔案匯入失敗。
    const doc = new Document();
    const buffer = doc.createBuffer();
    const primitive = doc.createPrimitive();
    primitive.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(TRI).setBuffer(buffer),
    );
    // 刻意不呼叫 setIndices
    doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(primitive));
    doc.createScene('s');

    const result = await importGltf(await new NodeIO().writeBinary(doc), 'noindex.glb');
    expect(result.primitives).toHaveLength(1);
    expect(result.primitives[0]!.mesh.indices.length).toBe(3);
  });

  it('opens a file that marks an extension as required', async () => {
    // required 的擴充沒註冊時，gltf-transform 直接拋錯 —— 不是降級，
    // 是整個檔案讀不進來。註冊擴充不代表支援它，只代表打得開。
    const doc = new Document();
    const buffer = doc.createBuffer();
    const unlit = doc.createExtension(KHRMaterialsUnlit).setRequired(true);
    const material = doc
      .createMaterial('m')
      .setExtension('KHR_materials_unlit', unlit.createUnlit());

    const primitive = doc.createPrimitive().setMaterial(material);
    primitive.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(TRI).setBuffer(buffer),
    );
    primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(IDX).setBuffer(buffer));
    doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(primitive));
    doc.createScene('s');

    const bytes = await new NodeIO()
      .registerExtensions([KHRMaterialsUnlit])
      .writeBinary(doc);

    // 沒註冊擴充的 IO 讀不了 —— 這一行證明上面那個檔案真的需要擴充，
    // 否則下面的斷言只是在驗一個普通檔案。
    await expect(new NodeIO().readBinary(bytes)).rejects.toThrow(/required extension/i);

    const result = await importGltf(bytes, 'unlit.glb');
    expect(result.primitives).toHaveLength(1);
  });
});
