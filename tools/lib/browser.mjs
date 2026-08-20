/**
 * 關卡怎麼開瀏覽器。**一條退路鏈，一個看得懂的錯誤訊息。**
 *
 * ## 為什麼要收起來
 *
 * 原本有四種寫法散在 44 個檔裡：
 *
 * | 寫法 | 幾個檔 | 找不到 Chrome 時 |
 * | --- | ---: | --- |
 * | `launch()` helper（自己複製一份） | 8 | 講「無法啟動瀏覽器」並列出每個嘗試 |
 * | `launch({ channel: 'chrome', headless: false, args })` | 22 | Playwright 的原始例外 |
 * | `launch({ channel: 'chrome' })` | 6 | 同上 |
 *
 * 那 28 個沒有退路的，在一台只裝了 Chromium 的機器上會丟出 Playwright 的
 * 原始訊息 —— 它講的是「Executable doesn't exist」加上一串路徑，而真正該
 * 講的是「這台機器上這道關卡跑不了，因為它需要有頭的 Chrome」。
 *
 * ## 預設有頭，而那不是每一關都對
 *
 * 無頭沒有真的 GPU。二十幾道畫面關卡量的是真的 GPU 時間、真的畫出來的
 * 像素、真的 shader 編譯成本 —— 無頭下那三件事全部是 SwiftShader 的軟體
 * 模擬，數字沒有意義而且**看起來完全正常**。所以預設是有頭。
 *
 * 但 `package-check` 與 `site-check` 要在 CI 上跑，而 GitHub 的 runner
 * **沒有顯示器** —— 有頭在那裡啟動不起來（錯誤訊息是
 * `Target page, context or browser has been closed`，指不到真正的原因）。
 *
 * 那兩關量的東西也不需要真的 GPU：一個問「worker 起不起得來」，一個問
 * 「下載多少、多久看得到」。所以它們明著傳 `headless: true`。
 */
import { chromium } from 'playwright';

/**
 * 開一個瀏覽器。
 *
 * @param {{ webgpu?: boolean, headless?: boolean }} [options]
 *   `webgpu` 會加上 `--enable-unsafe-webgpu`（WebGPU 那條路的關卡要）。
 *   `headless` 預設 false —— 見上面「為什麼一定要有頭」。
 *
 * 依序試 Chrome stable、再試 Playwright 自己那份 Chromium。兩個都不行才丟，
 * 而訊息裡帶著每一次失敗的第一行 —— 「兩個都試過了，各自為什麼不行」比
 * 「其中一個的堆疊」有用得多。
 */
export async function launchBrowser(options = {}) {
  const args = options.webgpu === true ? ['--enable-unsafe-webgpu'] : [];
  const headless = options.headless ?? false;
  const attempts = [
    { channel: 'chrome', headless, args },
    { headless, args },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch(attempt);
    } catch (error) {
      errors.push(`${attempt.channel ?? 'chromium'}：${String(error).split('\n')[0]}`);
    }
  }
  throw new Error(
    ['無法啟動瀏覽器。這道關卡需要有頭的瀏覽器（無頭沒有真的 GPU）。', ...errors].join('\n  '),
  );
}
