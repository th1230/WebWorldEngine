import { Fn, sin, uv, vec3, vec4 } from 'three/tsl';
import {
  DataTexture,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  NoColorSpace,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  type Texture,
} from 'three/webgpu';
import { DEFAULT_SEED, createRng } from '../rng.ts';
import {
  boolParam,
  numberParam,
  type BenchmarkScene,
  type SceneContext,
  type SceneDefinition,
} from './types.ts';
import { rawScene } from './raw-scene.ts';

/**
 * 建一條長度可控的 TSL 運算鏈。
 *
 * 迴圈是在 **建圖時**展開的，不是 shader 執行期的 loop —— 產生的是一段真正很長的
 * shader，這正是「材質複雜度」要量的東西。
 */
function expensiveColorNode(iterations: number) {
  return Fn(() => {
    const texcoord = uv();
    // 用 TSL 變數 + assign，而不是在 JS 端重新指派節點：
    // 前者產生一個真正的 shader 變數，後者會堆出一棵巨大的運算式樹。
    const acc = vec3(texcoord.x, texcoord.y, 0.5).toVar();
    for (let i = 0; i < iterations; i++) {
      acc.assign(acc.mul(1.0001).add(sin(acc.yzx.mul(1.7 + i * 0.013)).mul(0.01)));
    }
    return vec4(acc, 1.0);
  })();
}

// ── material-complexity ───────────────────────────────────────────────────

export const materialComplexityScene: SceneDefinition = {
  id: 'material-complexity',
  title: '材質複雜度與 overdraw',
  measures: 'fragment shader 成本與 fill rate。層數控制 overdraw，迭代數控制單一 fragment 的算量。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const iterations = numberParam(ctx.params, 'iterations', 48, 1, 512);
    const layers = numberParam(ctx.params, 'layers', 8, 1, 64);

    const scene = new Scene();
    const camera = new PerspectiveCamera(60, ctx.aspect, 0.1, 100);
    camera.position.set(0, 0, 5);

    const geometry = new PlaneGeometry(2, 2);
    const materials: MeshBasicNodeMaterial[] = [];

    for (let i = 0; i < layers; i++) {
      const material = new MeshBasicNodeMaterial();
      material.colorNode = expensiveColorNode(iterations);
      // 透明 + 不寫深度：強制每一層都真的被著色，避免 early-z 把 overdraw 消掉
      material.transparent = true;
      material.depthWrite = false;
      material.opacity = 0.35;
      material.side = DoubleSide;
      materials.push(material);

      const mesh = new Mesh(geometry, material);
      // 每層都填滿視野，並稍微往後排開
      mesh.position.z = -i * 0.02;
      mesh.scale.setScalar(6);
      scene.add(mesh);
    }

    return Promise.resolve(
      rawScene(scene, camera, {
        update: () => {
          // 相機固定：這個場景量的是每 pixel 的成本，移動只會引入無關變因
        },
        reportParams: { iterations, layers },
        notes: [],
        dispose: () => {
          geometry.dispose();
          for (const m of materials) m.dispose();
        },
      }),
    );
  },
};

// ── texture-load ──────────────────────────────────────────────────────────

function makeNoiseTexture(size: number, seed: number): DataTexture {
  const rng = createRng(seed);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rng.int(0, 256);
    data[i + 1] = rng.int(0, 256);
    data[i + 2] = rng.int(0, 256);
    data[i + 3] = 255;
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export const textureLoadScene: SceneDefinition = {
  id: 'texture-load',
  title: '貼圖記憶體與上傳頻寬',
  measures:
    'VRAM 佔用與上傳成本。與 renderer.info.memory.texturesSize 對照，驗證記憶體統計是否可信。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const requested = numberParam(ctx.params, 'count', 48, 1, 512);
    const size = numberParam(ctx.params, 'size', 512, 16, 4096);

    // 未壓縮 RGBA8 + mipmap 約為 size²×4×1.34。設 1.5GB 上限避免直接把分頁打掛。
    const bytesEach = size * size * 4 * 1.34;
    const maxBytes = 1.5 * 1024 * 1024 * 1024;
    const count = Math.max(1, Math.min(requested, Math.floor(maxBytes / bytesEach)));

    const notes: string[] = [];
    if (count < requested) {
      notes.push(`貼圖數量由 ${requested} 降到 ${count}，否則會超過 1.5GB 上限`);
    }

    const scene = new Scene();
    const camera = new PerspectiveCamera(60, ctx.aspect, 0.1, 200);
    camera.position.set(0, 0, 30);

    const geometry = new PlaneGeometry(1, 1);
    const textures: Texture[] = [];
    const materials: MeshBasicNodeMaterial[] = [];
    const columns = Math.ceil(Math.sqrt(count));

    for (let i = 0; i < count; i++) {
      const texture = makeNoiseTexture(size, DEFAULT_SEED + i);
      textures.push(texture);

      const material = new MeshBasicNodeMaterial();
      material.map = texture;
      materials.push(material);

      const mesh = new Mesh(geometry, material);
      mesh.position.set((i % columns) - columns / 2, Math.floor(i / columns) - columns / 2, 0);
      scene.add(mesh);
    }

    return Promise.resolve(
      rawScene(scene, camera, {
        update: () => {},
        reportParams: {
          count,
          size,
          approxTextureMB: Math.round((count * bytesEach) / (1024 * 1024)),
        },
        notes,
        dispose: () => {
          geometry.dispose();
          for (const t of textures) t.dispose();
          for (const m of materials) m.dispose();
        },
      }),
    );
  },
};

// ── shader-compile ────────────────────────────────────────────────────────

export const shaderCompileScene: SceneDefinition = {
  id: 'shader-compile',
  title: 'Shader 編譯 stutter',
  measures:
    '大量互異材質造成的首幀編譯停頓，以及 compileAsync() 能消掉多少。對應permutation 風險。',
  async create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 128, 1, 512);
    const precompile = boolParam(ctx.params, 'precompile', false);
    // 每個材質的鏈長都不同，因此每個都是獨立的 shader program。
    // 初版用 8–32 的鏈長，編譯太快，cold 與 precompiled 量不出差別；
    // 加長到 32–80 才讓編譯成本大到足以被 earlyFrames 觀察到。
    const minChain = numberParam(ctx.params, 'minChain', 32, 1, 256);
    const chainSpread = numberParam(ctx.params, 'chainSpread', 48, 1, 256);

    const scene = new Scene();
    const camera = new PerspectiveCamera(60, ctx.aspect, 0.1, 200);
    camera.position.set(0, 0, 24);

    const geometry = new PlaneGeometry(1, 1);
    const materials: MeshBasicNodeMaterial[] = [];
    const columns = Math.ceil(Math.sqrt(count));

    for (let i = 0; i < count; i++) {
      const material = new MeshBasicNodeMaterial();
      // 每個材質的運算鏈長度都不同 → 每個都是一支獨立的 shader program
      material.colorNode = expensiveColorNode(minChain + (i % chainSpread));
      materials.push(material);

      const mesh = new Mesh(geometry, material);
      mesh.position.set((i % columns) - columns / 2, Math.floor(i / columns) - columns / 2, 0);
      scene.add(mesh);
    }

    const notes: string[] = [];
    if (precompile) {
      await ctx.backend.precompileRaw(scene, camera);
      notes.push('已於量測前執行 compileAsync()');
    } else {
      notes.push('未預先編譯：前幾幀包含 shader 編譯成本');
    }

    return rawScene(scene, camera, {
      update: () => {},
      reportParams: { count, precompile, minChain, chainSpread },
      notes,
      // 這個場景要量的正是首幀成本，所以絕不能暖機
      overrideWarmupFrames: 0,
      dispose: () => {
        geometry.dispose();
        for (const m of materials) m.dispose();
      },
    });
  },
};
