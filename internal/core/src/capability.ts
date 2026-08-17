/**
 * Capability 與品質分級的**型別**定義。
 *
 * 這些型別放在 core 而不是 platform-web，是因為 render-core、diagnostics 都要引用它們，
 * 但它們不該因此依賴瀏覽器探測邏輯。實際探測在 @ww/platform-web。
 */

export type RenderBackendKind = 'webgpu' | 'webgl2' | 'none';

/** GPU texture 壓縮家族。決定 Asset Cooker 要產生哪些 KTX2 變體。 */
export type TextureCompressionFamily = 'bc' | 'etc2' | 'astc';

/**
 * 品質層級。
 *
 * 這是**起始值**，不是最終畫質。執行期的 Adaptive Quality Manager會依實測
 * frame time 再往上或往下調。只負責產生這個起始值。
 */
export const QualityTier = {
  /** Tier 0：相容模式。WebGL2 fallback、軟體 adapter、或缺少 compute。 */
  Compatibility: 0,
  /** Tier 1：內顯或低階獨顯。 */
  Entry: 1,
  /** Tier 2：桌機中階。 */
  DesktopMedium: 2,
  /** Tier 3：桌機高階。 */
  DesktopHigh: 3,
  /** Tier 4：實驗性。啟用尚未穩定的路徑。 */
  ExperimentalUltra: 4,
} as const;

export type QualityTier = (typeof QualityTier)[keyof typeof QualityTier];

export const QUALITY_TIER_NAMES: Record<QualityTier, string> = {
  [QualityTier.Compatibility]: 'Tier 0 Compatibility',
  [QualityTier.Entry]: 'Tier 1 Entry / iGPU',
  [QualityTier.DesktopMedium]: 'Tier 2 Desktop Medium',
  [QualityTier.DesktopHigh]: 'Tier 3 Desktop High',
  [QualityTier.ExperimentalUltra]: 'Tier 4 Experimental Ultra',
};

export interface AdapterIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  /**
   * 瀏覽器回報這是軟體 / fallback adapter（例如 SwiftShader）。
   * 這種 adapter 的效能數字完全不能當基準，必須強制 Tier 0。
   */
  isFallbackAdapter: boolean;
}

export const UNKNOWN_ADAPTER: AdapterIdentity = {
  vendor: '',
  architecture: '',
  device: '',
  description: '',
  isFallbackAdapter: false,
};

/**
 * CapabilityProfile。
 *
 * 重點是「支援 WebGPU」不能只是一個 boolean —— 實際暴露哪些 feature 與 limit
 * 是由 adapter、瀏覽器與 user agent 共同決定的。
 */
export interface CapabilityProfile {
  backend: RenderBackendKind;
  compute: boolean;
  indirectDraw: boolean;
  storageTextures: boolean;
  timestampQueries: boolean;
  textureCompression: readonly TextureCompressionFamily[];
  maxTextureSize: number;
  maxStorageBufferSize: number;
  maxBindGroups: number;
  outputHDR: boolean;
  multiview: boolean;

  adapter: AdapterIdentity;
  /** adapter 回報的原始 feature 名稱，未經解讀。 */
  features: readonly string[];
  /** adapter 回報的原始 limits，全部保留，之後不必重新探測。 */
  limits: Readonly<Record<string, number>>;
  /** 探測失敗時的原因；成功為 null。 */
  failureReason: string | null;
}

/** 完全沒有 GPU 可用時的 profile。呼叫端必須能處理這種情況而不是崩潰。 */
export const NO_BACKEND_PROFILE: CapabilityProfile = {
  backend: 'none',
  compute: false,
  indirectDraw: false,
  storageTextures: false,
  timestampQueries: false,
  textureCompression: [],
  maxTextureSize: 0,
  maxStorageBufferSize: 0,
  maxBindGroups: 0,
  outputHDR: false,
  multiview: false,
  adapter: UNKNOWN_ADAPTER,
  features: [],
  limits: {},
  failureReason: 'No GPU backend available',
};
