// a short message at the bottom of the screen, gone after 1.6 s
export function toast(msg: string) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);padding:6px 12px;border-radius:6px;'
    + 'background:rgba(20,24,30,.85);color:#fff;font:13px system-ui,sans-serif;z-index:1000;pointer-events:none';
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}

// a message that stays at the top of the screen until replaced or taken away (null)
let shown: HTMLDivElement | null = null;
export function banner(msg: string | null) {
  if (msg === null) { shown?.remove(); shown = null; return; }
  if (!shown) {
    shown = document.createElement('div');
    shown.setAttribute('role', 'alert');
    shown.style.cssText = 'position:fixed;left:50%;top:calc(12px + env(safe-area-inset-top, 0px));transform:translateX(-50%);max-width:calc(100% - 32px);'
      + 'padding:8px 14px;border-radius:6px;background:rgba(150,30,25,.92);color:#fff;font:14px system-ui,sans-serif;z-index:1000;pointer-events:none';
    document.body.append(shown);
  }
  shown.textContent = msg;
}
