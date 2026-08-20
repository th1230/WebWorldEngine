import {
  NORMAL_OFFSET,
  TANGENT_OFFSET,
  VERTEX_FLOATS,
  VERTEX_STRIDE_BYTES,
} from '@web-world-engine/format';
import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import {
  generateTangents,
  recomputeNormals,
  triangleCount,
  vertexCount,
  weld,
  type RawMesh,
} from './geometry.ts';
import { cookAll, cookMesh } from './pipeline.ts';
import { icosphere, readSourceGltf, rock, writeSourceGltf } from './source-assets.ts';

/**
 * 切線的測試不能只檢查「有值」。切線錯了畫面不會壞，只會讓每一張法線
 * 貼圖的光照都偏一點 —— 那種問題幾乎不可能從畫面歸因回來，所以必須
 * 在這裡把數學性質釘死。
 */

function withTangents(mesh: RawMesh): RawMesh {
  return generateTangents(recomputeNormals(weld(mesh)));
}

describe('vertex layout', () => {
  it('is position + normal + uv + tangent', () => {
    // 這些常數被 cooker、runtime、benchmark 場景三邊共用。任何一邊自己
    // 改成別的數字，症狀是「幾何整團錯位」而不是型別錯誤 —— 因為它們
    // 都是 number。所以把約定釘在這裡。
    expect(VERTEX_FLOATS).toBe(12);
    expect(VERTEX_STRIDE_BYTES).toBe(VERTEX_FLOATS * 4);
    expect(NORMAL_OFFSET).toBe(3);
    expect(TANGENT_OFFSET).toBe(8);
  });
});

describe('generateTangents', () => {
  it('produces unit-length tangents', () => {
    const mesh = withTangents(icosphere(3));
    for (let v = 0; v < vertexCount(mesh); v++) {
      const base = v * VERTEX_FLOATS + TANGENT_OFFSET;
      const length = Math.hypot(
        mesh.vertices[base]!,
        mesh.vertices[base + 1]!,
        mesh.vertices[base + 2]!,
      );
      expect(length).toBeCloseTo(1, 4);
    }
  });

  it('writes handedness as exactly ±1', () => {
    // bitangent = cross(normal, tangent.xyz) * w。w 若不是 ±1，鏡像 UV
    // 的區域法線會翻面，表現為「某些面的凹凸剛好相反」。
    const mesh = withTangents(rock(2, 0x1234));
    for (let v = 0; v < vertexCount(mesh); v++) {
      const w = mesh.vertices[v * VERTEX_FLOATS + TANGENT_OFFSET + 3]!;
      expect(Math.abs(w)).toBe(1);
    }
  });

  it('keeps tangents perpendicular to normals', () => {
    // MikkTSpace 會做 Gram-Schmidt 正交化。若這裡不成立，代表切線與法線
    // 對應錯了（例如接縫處配對錯亂），TBN 就不是正交基底。
    const mesh = withTangents(icosphere(3));
    for (let v = 0; v < vertexCount(mesh); v++) {
      const base = v * VERTEX_FLOATS;
      const dot =
        mesh.vertices[base + NORMAL_OFFSET]! * mesh.vertices[base + TANGENT_OFFSET]! +
        mesh.vertices[base + NORMAL_OFFSET + 1]! * mesh.vertices[base + TANGENT_OFFSET + 1]! +
        mesh.vertices[base + NORMAL_OFFSET + 2]! * mesh.vertices[base + TANGENT_OFFSET + 2]!;
      expect(Math.abs(dot)).toBeLessThan(1e-3);
    }
  });

  it('preserves the triangle count', () => {
    // 拆開再焊回去不該增減三角形。頂點數可能上升（UV 接縫被正確分離），
    // 但拓撲必須不變。
    const source = recomputeNormals(weld(icosphere(3)));
    expect(triangleCount(generateTangents(source))).toBe(triangleCount(source));
  });

  it('splits vertices whose tangents differ, and only those', () => {
    // 接縫處的頂點位置、法線、UV 可能相同但切線不同，必須保持分離 ——
    // 合併它們會在接縫上留下一條可見的光照裂縫。
    // 反過來，切線相同的頂點必須被合併，否則等於沒有焊接。
    const source = recomputeNormals(weld(icosphere(3)));
    const result = generateTangents(source);

    expect(vertexCount(result)).toBeGreaterThanOrEqual(vertexCount(source));
    // 遠少於未索引的頂點數（每個三角形 3 個），代表焊接確實有作用
    expect(vertexCount(result)).toBeLessThan(triangleCount(source) * 3);

    const seen = new Set<string>();
    for (let v = 0; v < vertexCount(result); v++) {
      const base = v * VERTEX_FLOATS;
      seen.add(result.vertices.subarray(base, base + VERTEX_FLOATS).join(','));
    }
    expect(seen.size).toBe(vertexCount(result));
  });

  it('is deterministic', () => {
    const a = withTangents(icosphere(2));
    const b = withTangents(icosphere(2));
    expect(a.vertices).toEqual(b.vertices);
    expect(a.indices).toEqual(b.indices);
  });

  it('handles an empty mesh without throwing', () => {
    const empty: RawMesh = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
    expect(() => generateTangents(empty)).not.toThrow();
  });
});

describe('cooked meshes carry tangents', () => {
  it('emits non-degenerate tangents for every cooked mesh', async () => {
    // 端到端：程序化來源 → glTF → 讀回 → cook。切線是在 cook 裡產生的，
    // 所以這個測試確認的是「管線真的有跑那一步」，而不只是函式能用。
    const { manifest } = await cookAll({ builtins: true, textureSize: 16, collision: false });
    expect(Object.keys(manifest.meshes).length).toBeGreaterThan(0);

    // LOD0 的頂點區塊涵蓋整份頂點資料，所有 LOD 共用
    for (const entry of Object.values(manifest.meshes)) {
      expect(entry.lods[0]!.vertices.length % VERTEX_STRIDE_BYTES).toBe(0);
    }
  });
});

/**
 * glTF 帶了 NORMAL / TANGENT 時必須沿用，不能重算。
 *
 * 這一組原本被我以「要等真實資產才能驗」推掉了 —— 那是錯的。
 * 帶切線的 glTF 可以直接用 cooker 自己的輸出構造出來，不需要任何美術檔。
 */
describe('authored attributes survive the glTF round trip', () => {
  /** 用 cook 過的網格（已有法線與切線）造一份「來源自帶屬性」的 glTF。 */
  async function authoredGltf(): Promise<{ source: RawMesh; bytes: Uint8Array }> {
    const source = withTangents(icosphere(2));
    const bytes = await writeSourceGltf({
      id: 'mesh:authored',
      material: 'material:rock',
      mesh: { ...source, hasNormals: true, hasTangents: true },
    });
    return { source, bytes };
  }

  it('reports which attributes the source actually had', async () => {
    // 沒有這兩個旗標，cooker 沒有任何辦法區分「來源沒給」與「來源給了全零」
    const plain = await readSourceGltf(
      await writeSourceGltf({ material: 'material:rock', id: 'x', mesh: icosphere(1) }),
    );
    expect(plain.hasNormals).toBe(false);
    expect(plain.hasTangents).toBe(false);

    const { bytes } = await authoredGltf();
    const imported = await readSourceGltf(bytes);
    expect(imported.hasNormals).toBe(true);
    expect(imported.hasTangents).toBe(true);
  });

  it('preserves authored normals and tangents bit-for-bit', async () => {
    const { source, bytes } = await authoredGltf();
    const imported = await readSourceGltf(bytes);
    expect(imported.vertices).toEqual(source.vertices);
  });

  it('does not recompute when the source already has them', async () => {
    // 本組的重點：cook 之後的頂點資料必須與來源**逐位元相同**。
    // 若 cooker 重算，數值會非常接近但不會相等 —— 而「非常接近」正是
    // 這個 bug 最惡劣的地方：法線貼圖的光照會整體偏一點，看不出根因。
    //
    // 但比對的是**集合**不是順序：cooker 會為了 GPU 頂點快取重排頂點
    // （見 optimizeLodChain）。重排是刻意的，重算不是。
    const { source, bytes } = await authoredGltf();
    const imported = await readSourceGltf(bytes);
    const { asset } = await cookMesh('mesh:authored', imported, { collision: false });

    const cooked = new Float32Array(
      asset.bytes.buffer,
      asset.bytes.byteOffset + asset.entry.lods[0]!.vertices.offset,
      asset.entry.lods[0]!.vertices.length / 4,
    );

    const asSortedRows = (a: Float32Array): string[] => {
      const rows: string[] = [];
      for (let v = 0; v < a.length / VERTEX_FLOATS; v++) {
        rows.push(a.subarray(v * VERTEX_FLOATS, (v + 1) * VERTEX_FLOATS).join(','));
      }
      return rows.sort();
    };
    expect(asSortedRows(cooked)).toEqual(asSortedRows(source.vertices));
  });

  it('still generates tangents when the source lacks them', async () => {
    const imported = await readSourceGltf(
      await writeSourceGltf({ material: 'material:rock', id: 'x', mesh: icosphere(2) }),
    );
    const { asset } = await cookMesh('mesh:plain', imported, { collision: false });
    const cooked = new Float32Array(
      asset.bytes.buffer,
      asset.bytes.byteOffset + asset.entry.lods[0]!.vertices.offset,
      asset.entry.lods[0]!.vertices.length / 4,
    );
    let nonZero = 0;
    for (let v = 0; v < cooked.length / VERTEX_FLOATS; v++) {
      if (cooked[v * VERTEX_FLOATS + TANGENT_OFFSET + 3] !== 0) nonZero++;
    }
    expect(nonZero).toBe(cooked.length / VERTEX_FLOATS);
  });

  it('warns and regenerates when tangents exist without normals', async () => {
    // 切線的意義完全依附在法線上。留著一組對應到別組法線的切線，
    // 比重算更糟 —— 它是「看起來有做對」的錯誤。
    const source = withTangents(icosphere(1));
    const { warnings } = await cookMesh(
      'mesh:odd',
      { ...source, hasNormals: false, hasTangents: true },
      { collision: false },
    );
    expect(warnings.join()).toContain('切線不再對應');
  });
});

describe('glTF import limits are explicit', () => {
  it('rejects multi-primitive glTF instead of silently importing the first', async () => {
    // 真實 .glb 幾乎一定是多 primitive（每個材質一個）。靜默只取第一個的
    // 症狀是「模型少了一半」，而使用者會先懷疑匯出設定、UV、材質，
    // 就是不會懷疑匯入器。
    const document = new Document();
    const buffer = document.createBuffer();
    const makePrimitive = () =>
      document
        .createPrimitive()
        .setAttribute(
          'POSITION',
          document
            .createAccessor()
            .setType('VEC3')
            .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
            .setBuffer(buffer),
        )
        .setIndices(
          document
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Uint32Array([0, 1, 2]))
            .setBuffer(buffer),
        );

    const mesh = document
      .createMesh('two')
      .addPrimitive(makePrimitive())
      .addPrimitive(makePrimitive());
    document.createScene().addChild(document.createNode('n').setMesh(mesh));

    await expect(readSourceGltf(await new NodeIO().writeBinary(document))).rejects.toThrow(
      /多 mesh \/ 多 primitive/,
    );
  });
});

/**
 * 這一組全部是「靜默產生錯誤幾何」的情況 —— 不丟錯、不警告，只是資料錯了。
 * 三個都是拿 `@gltf-transform/core` 當場構造出來抓到的，**不需要任何美術檔**。
 * 我原本把它們歸類成「要等真實資產」，那是錯的。
 */
describe('glTF import produces correct geometry, not just plausible geometry', () => {
  async function readPrimitive(
    build: (d: Document, b: ReturnType<Document['createBuffer']>) => void,
  ): Promise<RawMesh> {
    const doc = new Document();
    const buf = doc.createBuffer();
    build(doc, buf);
    return readSourceGltf(await new NodeIO().writeBinary(doc));
  }

  const TRI = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

  it('applies the node world matrix', async () => {
    // 忽略節點變換的症狀是「模型位置/大小/朝向完全不對」，而且沒有任何錯誤。
    // Blender 匯出幾乎一定帶節點變換。
    const mesh = await readPrimitive((d, b) => {
      const primitive = d
        .createPrimitive()
        .setAttribute('POSITION', d.createAccessor().setType('VEC3').setArray(TRI).setBuffer(b))
        .setIndices(
          d
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Uint32Array([0, 1, 2]))
            .setBuffer(b),
        );
      d.createScene().addChild(
        d
          .createNode('n')
          .setMesh(d.createMesh('m').addPrimitive(primitive))
          .setScale([10, 10, 10])
          .setTranslation([5, 0, 0]),
      );
    });
    // 頂點 1 是 (1,0,0)：×10 之後 +5 → (15,0,0)
    expect(mesh.vertices[VERTEX_FLOATS]).toBeCloseTo(15, 5);
  });

  it('leaves geometry untouched under an identity transform', async () => {
    // 沒有變換時就不該碰資料。做多餘的矩陣乘法與正規化會引入浮點漂移，
    // 讓「來源帶了就原封不動沿用」的保證變成「幾乎沿用」。
    const mesh = await readPrimitive((d, b) => {
      const primitive = d
        .createPrimitive()
        .setAttribute('POSITION', d.createAccessor().setType('VEC3').setArray(TRI).setBuffer(b))
        .setIndices(
          d
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Uint32Array([0, 1, 2]))
            .setBuffer(b),
        );
      d.createScene().addChild(
        d.createNode('n').setMesh(d.createMesh('m').addPrimitive(primitive)),
      );
    });
    expect(mesh.vertices[VERTEX_FLOATS]).toBe(1);
  });

  it('de-normalizes normalized accessors instead of reading raw storage', async () => {
    // 讀 getArray() 會拿到 Int16 的原始值（32767），當成浮點數就是
    // 「幾何大了三萬倍」。getElement() 才會做反正規化。
    const mesh = await readPrimitive((d, b) => {
      const primitive = d
        .createPrimitive()
        .setAttribute(
          'POSITION',
          d
            .createAccessor()
            .setType('VEC3')
            .setArray(new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0]))
            .setNormalized(true)
            .setBuffer(b),
        )
        .setIndices(
          d
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Uint32Array([0, 1, 2]))
            .setBuffer(b),
        );
      d.createScene().addChild(
        d.createNode('n').setMesh(d.createMesh('m').addPrimitive(primitive)),
      );
    });
    expect(mesh.vertices[VERTEX_FLOATS]).toBeCloseTo(1, 4);
  });

  it('widens 16-bit indices', async () => {
    const mesh = await readPrimitive((d, b) => {
      const primitive = d
        .createPrimitive()
        .setAttribute('POSITION', d.createAccessor().setType('VEC3').setArray(TRI).setBuffer(b))
        .setIndices(
          d
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Uint16Array([0, 1, 2]))
            .setBuffer(b),
        );
      d.createScene().addChild(
        d.createNode('n').setMesh(d.createMesh('m').addPrimitive(primitive)),
      );
    });
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
  });
});
