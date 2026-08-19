/**
 * WebWorld Engine —— Three.js 的強化層。
 *
 * 這是**唯一對外的套件**。其餘的 `@ww/*` 都是內部實作，使用者不該
 * 需要認識 entity、cell、ECS 這些字。
 *
 * ```js
 * import * as WW from '@webworld/three';
 *
 * const rocks = new WW.InstancedMesh(geometry, material, 10000);
 * for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, m);
 * scene.add(rocks);
 * ```
 *
 * 沒有初始化、沒有 `update()`。契約見 specs/api.md。
 */
export { InstancedMesh, type InstancedMeshOptions } from './instanced-mesh.ts';
export { MultiMesh, type MultiMeshOptions } from './multi-mesh.ts';
export { buildTerrain, type TerrainOptions, type TerrainTiles } from './terrain.ts';
export {
  AnimatedInstancedMesh,
  type AnimatedInstancedMeshOptions,
} from './animated-instanced-mesh.ts';
export {
  bakeVertexAnimation,
  type BakedVertexAnimation,
  type BakeOptions,
} from './vertex-animation.ts';
export { worldFor, World, type WorldStats } from './world.ts';
export { applyShadows, type CascadedShadows } from './shadows.ts';
export { Water, DEFAULT_WAVES, type WaterWave, type WaterOptions } from './water.ts';
export {
  computeBuoyancy,
  type BuoyancyBody,
  type BuoyancyForce,
  type BuoyancyOptions,
} from './buoyancy.ts';
export {
  PhysicsScheduler,
  type PhysicsSchedulerOptions,
  type PhysicsStats,
} from './physics-scheduler.ts';
export {
  OriginRebase,
  translateObject,
  type OriginRebaseOptions,
  type Rebasable,
} from './origin.ts';
export { isLodChain, pixelsPerUnit, selectLevel, type GeometrySource, type LodChain } from './lod-chain.ts';
export { sphericalLodErrors } from './spherical-error.ts';
export { load } from './load.ts';
export { loadMaterial, loadTexture } from './load-material.ts';
export { clearAssetCache } from './manifest.ts';
export { WorldStream, type StreamOptions, type PlaceFn } from './streaming.ts';
export {
  scatter,
  type ScatterRule,
  type ScatterContext,
  type ScatterPlacement,
} from './scatter.ts';
