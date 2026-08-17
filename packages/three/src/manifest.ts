import type { AssetManifest } from '@webworld/format';

/**
 * cook 過的資產共用的 manifest 取得與快取。
 *
 * 網格、貼圖、材質是三個不同的載入器，但它們讀的是**同一份 manifest**。
 * 各自抓一次的話，一個場景會為同一個 JSON 送出三個請求 —— 而且三份內容
 * 之間沒有任何東西保證一致。
 */

const manifests = new Map<string, Promise<AssetManifest>>();

/** 各載入器自己的快取清理函式。`clearAssetCache` 要能一次清乾淨。 */
const clearers: Array<() => void> = [];

/**
 * 把相對路徑解成絕對 URL。
 *
 * 快取的鍵必須是絕對的，否則 `'./a.wwm'` 與 `'/cooked/a.wwm'` 會被當成
 * 兩個不同的資產各抓一次。沒有 `location` 的環境（測試、worker）用一個
 * 固定的基底 —— 那時傳進來的本來就該是絕對路徑。
 */
export function resolveAssetUrl(url: string, base?: string): string {
  const fallback = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  return new URL(url, base ?? fallback).href;
}

export async function loadManifest(url: string): Promise<AssetManifest> {
  const cached = manifests.get(url);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<AssetManifest> => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`WW: 抓不到 manifest ${url}（HTTP ${response.status}）`);
    }
    return (await response.json()) as AssetManifest;
  })();

  manifests.set(url, pending);
  return pending;
}

/** 取回並抓出來，同時把「有哪些可以選」寫進錯誤訊息。 */
export function pick<T>(
  table: Record<string, T> | undefined,
  id: string,
  what: string,
  manifestUrl: string,
): T {
  const entry = table?.[id];
  if (entry !== undefined) return entry;

  // 打錯 id 是最常見的失誤，而「找不到」本身完全幫不上忙 —— 把清單一起
  // 給出去，答案通常就在裡面。
  const available = Object.keys(table ?? {});
  throw new Error(
    `WW: ${manifestUrl} 裡沒有${what}"${id}"。\n` +
      `有的是：${available.length === 0 ? '（一個都沒有）' : available.join(', ')}`,
  );
}

export function onClearAssetCache(clear: () => void): void {
  clearers.push(clear);
}

/** 清掉所有 cook 資產的快取。換資產版本或測試時用。 */
export function clearAssetCache(): void {
  manifests.clear();
  for (const clear of clearers) clear();
}
