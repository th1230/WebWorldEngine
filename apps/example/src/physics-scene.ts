import * as WW from '@web-world-engine/three';
import * as THREE from 'three';

/**
 * 一片有碰撞的地表、一堆會掉下來的箱子、一片會浮東西的水。
 *
 * ## 這個檔案在驗什麼
 *
 * 三個模組**從來沒有在真的場景裡跑過**：
 *
 * | | 單元測試驗得了 | 驗不了 |
 * | --- | --- | --- |
 * | `PhysicsScheduler` | 距離內的 id 會被啟用 | 剛體真的建出來、真的在算 |
 * | `buildHeightfield` | 取樣值與高度函式相符 | 送進 Rapier 之後**箱子踩在畫出來的地面上** |
 * | `computeBuoyancy` | 力的大小對 | 東西真的浮在**畫出來的**水面上 |
 *
 * 而那三個「驗不了」的失效方式全部是靜默的：箱子穿過地板、浮在半空、
 * 或者物理根本沒在跑而畫面看起來像靜止。
 *
 * ## 求解器是 Rapier，而套件對它一無所知
 *
 * `PhysicsScheduler` 進出的只有 id —— 剛體長什麼樣、誰在算，它不知道。
 * 所以這個檔案裡的每一行 Rapier 都是**應用程式的程式碼**，換掉求解器
 * 不必動到套件。
 */

export interface PhysicsScene {
  root: THREE.Group;
  update: (t: number) => void;
  stats: () => { active: number; awake: number; settled: number; floating: number; peakY: number };
}

const SIZE = 600;
const BOXES = 300;

/** 地表的高度函式。**畫面與碰撞共用這一個** —— 那正是重點。 */
function terrainHeight(x: number, z: number): number {
  return Math.sin(x * 0.008) * 18 + Math.cos(z * 0.011) * 14 - 20;
}

export async function makePhysicsScene(): Promise<PhysicsScene> {
  const RAPIER = await import('@dimforge/rapier3d-compat');
  await RAPIER.init();

  const root = new THREE.Group();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  // ── 地表：畫面 ────────────────────────────────────────────────────
  const terrain = WW.buildTerrain({ size: SIZE, tiles: 8, segments: 32, height: terrainHeight });
  const terrainMesh = new WW.MultiMesh(
    terrain.chains,
    new THREE.MeshStandardMaterial({ color: 0x4a5240, roughness: 0.95 }),
  );
  const m = new THREE.Matrix4();
  terrain.centers.forEach(([x, z], i) => terrainMesh.setMatrixAt(i, m.makeTranslation(x, 0, z)));
  root.add(terrainMesh);

  // ── 地表：碰撞 ────────────────────────────────────────────────────
  //
  // **同一個 `terrainHeight`**。自己重新取樣的話要猜原點、格距、列行順序，
  // 而猜錯的症狀是箱子浮在空中或陷進地裡 —— 不報錯，走到那一塊才看得到。
  const field = WW.buildHeightfield({ size: SIZE, samples: 129, height: terrainHeight });
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(field.rows - 1, field.columns - 1, field.heights, field.scale),
  );

  // ── 水 ────────────────────────────────────────────────────────────
  // 水位設在地表的中段，這樣一部分箱子會落進水裡 —— 浮力才驗得到。
  // 設得太低的話箱子全部停在乾地上，`floating` 永遠是 0 而那看起來像
  // 「浮力沒接上」，其實只是沒有東西碰到水。
  const water = new WW.Water({ level: -8 });
  const waterTime = { value: 0 };
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2a5a7a,
    roughness: 0.2,
    transparent: true,
    opacity: 0.8,
  });
  waterMat.onBeforeCompile = (shader): void => {
    shader.uniforms.wwWaterTime = waterTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float wwWaterTime;\n${water.displacementGLSL()}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 w = wwWaterDisplace( transformed.xy, wwWaterTime );
          transformed.x += w.x;
          transformed.y += w.z;
          transformed.z += w.y;
        }`,
      );
  };
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE, 96, 96), waterMat);
  surface.rotation.x = -Math.PI / 2;
  root.add(surface);

  // ── 箱子 ──────────────────────────────────────────────────────────
  const boxGeometry = new THREE.BoxGeometry(3, 3, 3);
  const boxes = new THREE.InstancedMesh(
    boxGeometry,
    new THREE.MeshStandardMaterial({ color: 0xc0864a, roughness: 0.7 }),
    BOXES,
  );
  root.add(boxes);

  const spawn: Array<[number, number, number]> = [];
  let seed = 3;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < BOXES; i++) {
    const x = (rand() - 0.5) * SIZE * 0.7;
    const z = (rand() - 0.5) * SIZE * 0.7;
    spawn.push([x, 40 + rand() * 30, z]);
  }

  // ## 只有靠近焦點的箱子才進求解器
  //
  // 沒有上限的話，一走進密集區就有幾千個剛體同時在算，那一幀直接卡住。
  // 而遠處的箱子動了也看不見 —— 那正是這個調度器存在的理由。
  const bodies = new Map<number, InstanceType<typeof RAPIER.RigidBody>>();

  /**
   * 每個 id 最後已知的姿勢。
   *
   * ## 為什麼非有它不可
   *
   * 調度器停用一個剛體時，**求解器裡那個物體就沒了**。下次它再靠近而重新
   * 啟用，若照原本的出生點建立，它就會從天上重新掉一次。
   *
   * 第一版就是那樣寫的，而症狀不是「錯誤」是**箱子永遠不會停** —— 焦點
   * 繞一圈回來，那批箱子又被重新丟一次。實測 240 步之後 119 個醒著、
   * 只有 1 個睡著，而它們其實早就落地了。
   *
   * 所以「停用時把狀態存起來、啟用時放回去」是使用這個調度器的**必要**
   * 步驟，不是優化。
   */
  const lastPose = new Map<
    number,
    { p: [number, number, number]; q: [number, number, number, number] }
  >();
  const scheduler = new WW.PhysicsScheduler({
    activeRadius: 200,
    maxActive: 120,
    onActivate(id) {
      const saved = lastPose.get(id);
      const [sx, sy, sz] = spawn[id]!;
      const [x, y, z] = saved?.p ?? [sx, sy, sz];
      const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z);
      if (saved !== undefined) {
        const [qx, qy, qz, qw] = saved.q;
        desc.setRotation({ x: qx, y: qy, z: qz, w: qw });
      }
      const body = world.createRigidBody(desc);
      // ## 密度要設成真的木頭，不能用預設
      //
      // Rapier 的碰撞體預設密度是 1，水是 1000 —— 照預設這顆 3×3×3 的箱子
      // 只有 27 kg 卻排開 27 m³ 的水，浮力是體重的一千倍，箱子會射到天上。
      // 600 是木頭，浮沉比 1.67，會穩穩浮著。
      world.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 1.5, 1.5).setDensity(600), body);
      bodies.set(id, body);
    },
    onDeactivate(id) {
      const body = bodies.get(id);
      if (body === undefined) return;
      // **先存再刪。** 不存的話它下次會從天上重新掉一次（見 `lastPose`）。
      const p2 = body.translation();
      const r2 = body.rotation();
      lastPose.set(id, { p: [p2.x, p2.y, p2.z], q: [r2.x, r2.y, r2.z, r2.w] });
      scheduler.move(id, p2.x, p2.y, p2.z);
      world.removeRigidBody(body);
      bodies.delete(id);
    },
  });
  spawn.forEach(([x, y, z], i) => scheduler.add(i, x, y, z));

  const focus = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  let awake = 0;
  let settled = 0;
  let floating = 0;
  /**
   * 有史以來看過的最高點。
   *
   * ## 為什麼是「有史以來」而不是「現在最高的那顆」
   *
   * 被浮力射出去的箱子會飛出調度器的啟用半徑，然後**被停用、從 `bodies`
   * 裡移除** —— 於是掃現有的剛體看不到它，統計數字乾乾淨淨。
   *
   * 實測過這件事：把 `resetForces` 拿掉之後箱子確實在飛，而當下的高度分佈
   * 完全正常，只有「浮著的數量從 34 掉到 1」那一個間接跡象。
   *
   * 記住峰值就抓得到，因為它飛出去**之前**一定先經過一個很高的位置。
   */
  let peakY = -Infinity;

  return {
    root,
    update(t: number): void {
      waterTime.value = t;
      // 焦點繞著世界走 —— 這樣啟用集合會一直換，才驗得到啟用／停用兩邊。
      focus.set(Math.cos(t * 0.15) * 180, 0, Math.sin(t * 0.15) * 180);
      scheduler.update(focus);

      // ## 浮力：用**畫出來的那個水面**
      //
      // 兩邊各算各的話箱子會陷進浪裡或飄在半空 —— 而 `Water` 存在的
      // 理由就是不讓那件事發生。
      const afloat: WW.BuoyancyBody[] = [];
      for (const [id, body] of bodies) {
        const p = body.translation();
        const v = body.linvel();
        afloat.push({
          id,
          x: p.x,
          y: p.y,
          z: p.z,
          radius: 1.86,
          mass: body.mass(),
          velocityX: v.x,
          velocityY: v.y,
          velocityZ: v.z,
        });
      }
      const forces = WW.computeBuoyancy(water, afloat, t);
      floating = forces.length;
      // **先清掉上一幀的力。** Rapier 的 addForce 是持續的，不清的話
      // 第 N 幀的力是 N 倍，箱子會加速射向天空（實測 20 秒飛到 y=183,996）。
      for (const body of bodies.values()) body.resetForces(true);
      for (const f of forces) {
        bodies.get(f.id)?.addForce({ x: f.x, y: f.y, z: f.z }, true);
      }

      world.step();

      awake = 0;
      settled = 0;
      for (let i = 0; i < BOXES; i++) {
        const body = bodies.get(i);
        if (body === undefined) {
          // 沒在算的就不畫 —— 它停在最後已知的位置，畫出來會是穿模的假象。
          boxes.setMatrixAt(i, hidden);
          continue;
        }
        const p = body.translation();
        const r = body.rotation();
        boxes.setMatrixAt(
          i,
          matrix.compose(
            new THREE.Vector3(p.x, p.y, p.z),
            new THREE.Quaternion(r.x, r.y, r.z, r.w),
            new THREE.Vector3(1, 1, 1),
          ),
        );
        if (body.isSleeping()) settled++;
        else awake++;
      }
      boxes.instanceMatrix.needsUpdate = true;
      for (const body of bodies.values()) peakY = Math.max(peakY, body.translation().y);
    },
    stats: () => {
      // 診斷用：箱子的高度分佈，以及它們與**地表函式**的落差。
      let below = 0;
      let minY = Infinity;
      let maxGap = 0;
      // 浮著的箱子應該停在**水面附近**，不是沉到地表。
      let afloatRest = 0;
      for (const body of bodies.values()) {
        const p2 = body.translation();
        minY = Math.min(minY, p2.y);
        const ground = terrainHeight(p2.x, p2.z);
        if (p2.y < ground - 5) below++;
        if (body.isSleeping()) maxGap = Math.max(maxGap, Math.abs(p2.y - ground - 1.5));
        // 停在水面 ±3 以內，而且明顯高於地表 —— 那就是真的浮著。
        if (Math.abs(p2.y - water.heightAt(p2.x, p2.z, 0)) < 3 && p2.y > ground + 3) afloatRest++;
      }
      return {
        active: bodies.size,
        awake,
        settled,
        floating,
        below,
        minY: Math.round(minY),
        maxGap: Math.round(maxGap * 10) / 10,
        afloatRest,
        peakY: Math.round(peakY),
      };
    },
  };
}
