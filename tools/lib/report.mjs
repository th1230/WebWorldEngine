/**
 * 關卡怎麼報結果。**一種格式。**
 *
 * ## 為什麼要收起來
 *
 * 那四行原本有四種寫法散在 18 個檔裡，差別只有 `✓` 與字面的 `✓`
 * （輸出一模一樣），以及有沒有第三個 `detail` 參數。
 *
 * 收成一份的好處不是省那四行，是**輸出從此一定一致**：一個人掃 26 道關卡
 * 的日誌時，格式不一樣的那幾行會被眼睛當成不同的東西。
 *
 * ## 為什麼是回傳閉包而不是模組層的變數
 *
 * 模組層的計數器會在同一個 process 裡跑兩道關卡時互相污染。現在沒有那種
 * 用法，但那是「今天剛好不會咬人」而不是「不會咬人」。
 *
 * 而且**不用 `this`** —— 呼叫端一律是 `const { check, finish } = startReport(…)`，
 * 解構之後 `this` 就沒了。方法寫成閉包，解不解構都一樣。
 */

/**
 * 開一份報告。
 *
 * ```js
 * const { check, finish } = startReport('接觸陰影：暗的地方要在接縫上');
 * check(value > 0.5, '接縫處真的暗了', value.toFixed(3));
 * finish('接觸陰影關卡');   // 有沒過的就 process.exit(1)
 * ```
 */
export function startReport(title) {
  console.log(title);
  let failed = 0;

  /**
   * 記一項。`detail` 是可選的第三段，會接在 `—— ` 後面。
   *
   * **量到的數字要放進 `detail`。** 只印過不過的話，一道關卡從綠變紅時
   * 沒有人知道它離門檻多遠 —— 而那個距離是判斷「真的壞了」還是「門檻
   * 訂太緊」的唯一依據。
   */
  const check = (ok, label, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` —— ${detail}`}`);
    if (!ok) failed++;
  };

  /**
   * 直接記一項失敗。給 `catch` 用。
   *
   * 有這一支是因為「關卡自己掛了」與「量出來不對」**是同一件事**：兩個都
   * 代表這一輪沒有證據。原本各檔在 catch 裡印一行自己的格式再 `failed++`，
   * 於是失敗的輸出長得跟成功的不一樣 —— 而失敗那一刻正是最需要看得懂的
   * 時候。
   */
  const fail = (label, detail) => check(false, label, detail);

  /** 純粹印一行說明，不算一項。 */
  const note = (text) => console.log(`  ${text}`);

  /**
   * 只記一筆失敗，**訊息由呼叫端自己印**。
   *
   * 給輸出有自己版面的關卡用：impostor 的 ✗ 縮在「相機距離 1500」底下四格，
   * split-value 的則是先累積進一個字串、整段一起印。硬套 `fail()` 會把那個
   * 結構打平，而那個結構是有意義的（哪一檔距離沒過）。
   *
   * **計數還是要走這裡。** 那才是 `finish()` 說得出實話的前提 —— 各自數
   * 各自的話，收尾只能相信其中一份。
   */
  const markFailed = () => {
    failed++;
  };

  /**
   * 收尾。沒過的話**非零離開** —— 關卡不會讓 CI 綠著過去。
   *
   * ## 「掛了」也算沒過
   *
   * 這裡除了自己的計數，還看 `process.exitCode`。原因是一個真的踩過的形狀：
   * catch 到例外時只設了 `process.exitCode = 1` 而沒有記進失敗計數，於是
   * **整關掛掉之後照樣印「全過」**。
   *
   * 離開碼是對的（CI 會紅），但印出來的字是錯的 —— 而人相信的是印出來的字。
   * 一個會說謊的關卡比沒有關卡更糟，因為它讓人停止懷疑。
   *
   * @param {string} name 關卡的名字，例如 `'接觸陰影關卡'`。
   */
  const finish = (name) => {
    console.log('');
    if (failed > 0) {
      console.log(`${name}：${failed} 項沒過`);
      process.exit(1);
    }
    if (process.exitCode) {
      console.log(`${name}：掛了，沒跑完`);
      process.exit(1);
    }
    console.log(`${name}：全過`);
  };

  return {
    check,
    fail,
    markFailed,
    note,
    finish,
    get failed() {
      return failed;
    },
  };
}
