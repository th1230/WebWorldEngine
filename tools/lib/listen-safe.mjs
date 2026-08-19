/**
 * 開一個瀏覽器連得上的埠。
 *
 * ## 為什麼不能直接 listen(0)
 *
 * `listen(0)` 是跟作業系統要一個沒人用的埠，而作業系統不知道 Chrome 的規矩：
 * Chrome 有一份**拒絕連線的埠清單**（那些埠歷史上被拿來做別的協定），連到
 * 上面會直接回 `net::ERR_UNSAFE_PORT`，連請求都不會送出去。
 *
 * 真的發生過：impostor 關卡拿到 1720（H.323），整關紅掉 —— 而它跟 impostor
 * 一點關係都沒有。**隨機會紅的關卡不算關卡**（見 doctrine 第 17 條）：紅的
 * 時候第一個念頭會是「又是那個」而不是「哪裡壞了」，而那個念頭一旦養成，
 * 真的壞掉那次也會被同樣打發掉。
 *
 * 所以這裡拿到黑名單上的埠就換一個。重試而不是寫死某個埠，是因為寫死的話
 * 兩個關卡平行跑會撞在一起 —— 那會變成另一種隨機紅。
 */

/**
 * Chromium 的 `kRestrictedPorts`。
 *
 * 只列得到的（大於 1024 的那些）—— 小於 1024 的埠作業系統本來就不會發給
 * 非特權行程當臨時埠。
 */
const BLOCKED = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** 這個埠 Chrome 連得上嗎。 */
export function isBrowserSafePort(port) {
  return !BLOCKED.has(port);
}

/**
 * 讓 server 聽在一個瀏覽器連得上的臨時埠上。
 *
 * @returns 實際聽到的埠。
 */
export async function listenSafe(server, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const { port } = server.address();
    if (isBrowserSafePort(port)) return port;
    // 這個埠 Chrome 不收，關掉再要一個。
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error(`listenSafe: 試了 ${attempts} 次都拿到 Chrome 擋掉的埠。`);
}
