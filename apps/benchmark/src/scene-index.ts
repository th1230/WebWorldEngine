import { SCENES } from './scene-registry.ts';

/**
 * 沒有指定 `?scene=` 時顯示的場景清單。
 *
 * 之前這種情況會靜默套用某個預設場景，於是你必須先讀過原始碼才知道有哪些場景、
 * 叫什麼名字。開發用工具不該要求使用者先知道答案才能用。
 */

const STYLE = `
  max-width: 760px; margin: 0 auto; padding: 40px 24px; text-align: left;
  color: #e6edf3; font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
`;

const LINK_STYLE = `
  display: block; padding: 10px 12px; margin: 6px 0; border-radius: 6px;
  border: 1px solid rgba(110,118,129,.35); color: #79c0ff; text-decoration: none;
`;

export function renderSceneIndex(container: HTMLElement, errorMessage?: string): void {
  container.hidden = false;
  container.textContent = '';
  container.setAttribute('style', container.getAttribute('style') ?? '');

  const root = document.createElement('div');
  root.setAttribute('style', STYLE);

  if (errorMessage !== undefined) {
    const error = document.createElement('div');
    error.setAttribute(
      'style',
      'color:#ff7b72;border:1px solid #ff7b72;border-radius:6px;padding:10px 12px;margin-bottom:16px;',
    );
    error.textContent = errorMessage;
    root.append(error);
  }

  const heading = document.createElement('div');
  heading.setAttribute('style', 'color:#7ee787;font-size:15px;margin-bottom:4px;');
  heading.textContent = 'WebWorld Engine — Benchmark';
  root.append(heading);

  const subtitle = document.createElement('div');
  subtitle.setAttribute('style', 'color:#8b949e;margin-bottom:20px;');
  subtitle.textContent = '選一個場景。全部使用合成資料，量到的是硬體與 backend 的上限。';
  root.append(subtitle);

  for (const scene of SCENES) {
    const link = document.createElement('a');
    link.href = `?scene=${encodeURIComponent(scene.id)}`;
    link.setAttribute('style', LINK_STYLE);

    const title = document.createElement('div');
    title.textContent = `${scene.id} — ${scene.title}`;
    const measures = document.createElement('div');
    measures.setAttribute('style', 'color:#8b949e;margin-top:2px;');
    measures.textContent = scene.measures;

    link.append(title, measures);
    root.append(link);
  }

  const hints = document.createElement('div');
  hints.setAttribute('style', 'color:#8b949e;margin-top:24px;');
  hints.textContent = [
    '常用參數：',
    '  &forceWebGL=1   走 WebGL2 降級路徑（compute 與 indirect draw 會被停用）',
    '  &timestamps=0   關閉 GPU timestamp query',
    '  &frames=600     量測幀數        &warmup=120   暖機幀數（會被丟棄）',
    '  &autorun=1      跑完固定幀數後產生報告並停止',
    '',
    '場景各自的參數見 specs/benchmark.md。',
  ].join('\n');
  hints.style.whiteSpace = 'pre';
  root.append(hints);

  container.append(root);
}
