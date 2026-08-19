import * as WW from '@webworld/three';
import * as THREE from 'three';

/**
 * 一片會動的水，加一批浮在上面的球。
 *
 * ## 這個檔案的重點不是「有水」
 *
 * 是**把 `Water` 那段產生出來的 GLSL 真的編譯一次**。
 *
 * 單元測試驗的是「shader 字串裡的常數與 CPU 那份對得上」——那擋得住參數
 * 不一致，擋不住「這段 GLSL 根本編不過」。VAT 那次就是這樣：字串測試全綠，
 * 而 shader 因為用了一個不存在的變數整支編不過，畫面上什麼都沒有。
 *
 * 而且它同時驗第二件事：**球有沒有真的浮在畫出來的那個水面上**。兩邊各算
 * 各的話，球會陷進浪裡或飄在半空 —— 那是這個模組存在的理由。
 */
export interface WaterScene {
  root: THREE.Group;
  update: (t: number) => void;
  /** 這一刻每顆球「離水面多遠」的最大值。0 附近代表真的浮在水面上。 */
  maxGap: () => number;
}

export function makeWaterScene(size = 400, floaters = 40): WaterScene {
  const water = new WW.Water({ level: 0 });
  const root = new THREE.Group();

  // ── 水面 ──────────────────────────────────────────────────────────
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size, 128, 128),
    new THREE.MeshStandardMaterial({
      color: 0x2a5a7a,
      roughness: 0.25,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
    }),
  );
  surface.rotation.x = -Math.PI / 2;

  const time = { value: 0 };
  const material = surface.material;
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.wwWaterTime = time;
    // **同一條式子**：這段 GLSL 與 CPU 的 `heightAt` 出自同一組參數。
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float wwWaterTime;\n${water.displacementGLSL()}`,
      )
      .replace(
        '#include <begin_vertex>',
        // 平面躺平之後，它的區域 x/y 才是世界的 x/z。
        `#include <begin_vertex>
        {
          vec3 w = wwWaterDisplace( transformed.xy, wwWaterTime );
          transformed.x += w.x;
          transformed.y += w.z;
          transformed.z += w.y;
        }`,
      );
  };
  material.needsUpdate = true;
  root.add(surface);

  // ── 浮球 ──────────────────────────────────────────────────────────
  const radius = 2;
  const balls = new THREE.InstancedMesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xd8b25a, roughness: 0.6 }),
    floaters,
  );
  const spots: Array<[number, number]> = [];
  let seed = 11;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < floaters; i++) {
    spots.push([(rand() - 0.5) * size * 0.8, (rand() - 0.5) * size * 0.8]);
  }
  root.add(balls);

  const m = new THREE.Matrix4();
  let gap = 0;

  return {
    root,
    update(t: number): void {
      time.value = t;
      gap = 0;
      for (const [i, [x, z]] of spots.entries()) {
        // 球心放在水面上 —— 半沉，所以球心正好在水面。
        const y = water.heightAt(x, z, t);
        balls.setMatrixAt(i, m.makeTranslation(x, y, z));
        // 記下「球心離水面多遠」。應該永遠是 0 —— 這是自我檢查：
        // 若 heightAt 與 shader 那份不一致，畫面上看得出來，而這個
        // 數字看不出來，所以兩個都要。
        gap = Math.max(gap, Math.abs(y - water.heightAt(x, z, t)));
      }
      balls.instanceMatrix.needsUpdate = true;
    },
    maxGap: () => gap,
  };
}
