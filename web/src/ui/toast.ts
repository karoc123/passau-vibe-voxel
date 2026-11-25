// a short message at the bottom of the screen, gone after 1.6 s
export function toast(msg: string) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);padding:6px 12px;border-radius:6px;'
    + 'background:rgba(20,24,30,.85);color:#fff;font:13px system-ui,sans-serif;z-index:1000;pointer-events:none';
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}
