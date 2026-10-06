// Best-effort, page-local visual feedback for agent actions.
export const ACTION_OVERLAY_SELECTOR = "[data-bro-relay-action-overlay]";

// A hint that disappears before the operator can look at the window is not
// feedback. Every action refreshes the timer, so one hint covers a whole batch.
// Screenshots dismiss it first, so it never lands in the agent's own evidence.
export const OVERLAY_LIFETIME_MS = { show: 2600, ripple: 1400, max: 2600 };

// page-agent-style pointer: a white paper-plane arrow with a blue→purple edge.
// A rAF loop eases the cursor toward its target so the motion between actions
// stays visible instead of teleporting per call.
const CURSOR_SVG = `<svg viewBox="0 0 100 100"><defs><linearGradient id="broRelayG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#39b6ff"/><stop offset="1" stop-color="#bd45fb"/></linearGradient></defs><path d="M 15 42 L 15 36.99 Q 15 31.99 23.7 31.99 L 28.05 31.99 Q 32.41 31.99 32.41 21.99 L 32.41 17 Q 32.41 12 41.09 16.95 L 76.31 37.05 Q 85 42 76.31 46.95 L 41.09 67.05 Q 32.41 72 32.41 62.01 L 32.41 57.01 Q 32.41 52.01 23.7 52.01 L 19.35 52.01 Q 15 52.01 15 47.01 Z" fill="#fff" stroke="url(#broRelayG)" stroke-width="7" stroke-linejoin="round"/></svg>`;

const OVERLAY_CSS = `:host{all:initial}
.veil{position:fixed;inset:0;background:linear-gradient(115deg,transparent 42%,rgba(129,140,248,.08) 50%,transparent 58%);background-size:260% 100%;animation:sheen 2.2s linear infinite}
.edge{position:fixed;inset:0;box-shadow:inset 0 0 0 2px rgba(99,102,241,.4),inset 0 0 30px rgba(99,102,241,.15);animation:edgePulse 1.6s ease-in-out infinite}
.cursor{position:fixed;left:0;top:0;width:44px;height:44px;margin:0;will-change:transform;opacity:0;transition:opacity 160ms ease;filter:drop-shadow(0 3px 6px rgba(49,46,129,.4))}
.cursor.on{opacity:1}
.cursor svg{display:block;width:100%;height:100%;transform-origin:50% 50%;transform:rotate(-135deg) scale(1.15);transition:transform 140ms ease}
.cursor.press svg{transform:rotate(-135deg) scale(.9)}
.label{position:fixed;box-sizing:border-box;display:flex;align-items:center;gap:6px;max-width:calc(100vw - 16px);padding:4px 10px;border:1px solid #ffffff40;border-radius:999px;background:linear-gradient(135deg,#312e81,#4338ca);color:#fff;font:500 12px/18px system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 10px #0003}
.label::before{content:'';flex:none;width:6px;height:6px;border-radius:50%;background:#a5b4fc;animation:pulseDot 1s ease-in-out infinite}
.target{box-sizing:border-box;position:fixed;border:2px solid #2563eb;border-radius:6px;background:#2563eb18;box-shadow:0 0 0 2px #fff8;transition:left 140ms ease,top 140ms ease,width 140ms ease,height 140ms ease}
.target.pop{animation:lockon 300ms ease-out}
.ripple{box-sizing:border-box;position:fixed;width:26px;height:26px;margin:-13px;border:2.5px solid rgba(57,182,255,.85);border-radius:50%;background:radial-gradient(circle,rgba(57,182,255,.2),transparent 70%);box-shadow:0 0 14px rgba(57,182,255,.45);animation:ripple 480ms ease-out forwards}
@keyframes sheen{from{background-position:120% 0}to{background-position:-20% 0}}
@keyframes edgePulse{0%,100%{opacity:.65}50%{opacity:1}}
@keyframes pulseDot{0%,100%{opacity:.4}50%{opacity:1}}
@keyframes lockon{0%{transform:scale(1.14);box-shadow:0 0 0 5px rgba(37,99,235,.45)}100%{transform:scale(1)}}
@keyframes ripple{0%{transform:scale(.45);opacity:.95}100%{transform:scale(3);opacity:0}}
.label[hidden],.target[hidden]{display:none}
@media(prefers-reduced-motion:reduce){.veil,.edge,.target.pop,.label::before{animation:none}.cursor,.cursor svg,.target{transition:none}.ripple{animation:none;opacity:0}}`;

const expression = (operation, args = {}) =>
  `(() => { try {
    const key = ${JSON.stringify(ACTION_OVERLAY_SELECTOR)}, op = ${JSON.stringify(operation)}, args = ${JSON.stringify(args)};
    const viewport = { width: innerWidth, height: innerHeight };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const existing = document.querySelector(key);
    if (op === 'dismiss') {
      if (existing) { const s = existing.__broRelayState || {}; clearTimeout(existing.__broRelayIdle); clearTimeout(s.snapTimer); cancelAnimationFrame(s.raf || 0); existing.remove(); }
      return { ok: true, dismissed: !!existing, viewport };
    }
    let host = existing, root = host && host.__broRelayRoot;
    if (host && !host.__broRelayState) { host.remove(); host = null; root = null; }
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-bro-relay-action-overlay', '');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      root = host.attachShadow({ mode: 'closed' });
      host.__broRelayRoot = root;
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(OVERLAY_CSS)};
      const veil = document.createElement('div'), edge = document.createElement('div'),
        target = document.createElement('div'), cursor = document.createElement('div'),
        label = document.createElement('div');
      veil.className = 'veil'; edge.className = 'edge'; target.className = 'target';
      cursor.className = 'cursor'; label.className = 'label';
      cursor.innerHTML = ${JSON.stringify(CURSOR_SVG)};
      target.hidden = true; label.hidden = true;
      root.append(style, veil, edge, target, cursor, label);
      const spawn = document.__broRelayPointer || { x: viewport.width / 2, y: viewport.height / 2 };
      const st = host.__broRelayState = { cx: spawn.x, cy: spawn.y, tx: spawn.x, ty: spawn.y,
        mq: matchMedia('(prefers-reduced-motion: reduce)'), raf: 0 };
      const step = () => {
        if (!host.isConnected) return;
        const k = st.mq.matches ? 1 : 0.22;
        st.cx += (st.tx - st.cx) * k;
        st.cy += (st.ty - st.cy) * k;
        if (Math.abs(st.tx - st.cx) < 0.4) st.cx = st.tx;
        if (Math.abs(st.ty - st.cy) < 0.4) st.cy = st.ty;
        cursor.style.transform = 'translate3d(' + st.cx + 'px,' + st.cy + 'px,0)';
        st.raf = requestAnimationFrame(step);
      };
      // rAF freezes when the page is not being rendered (occluded/minimized);
      // the cursor must still land on the target instead of freezing mid-flight.
      st.snap = () => {
        clearTimeout(st.snapTimer);
        st.snapTimer = setTimeout(() => {
          if (st.cx === st.tx && st.cy === st.ty) return;
          st.cx = st.tx; st.cy = st.ty;
          cursor.style.transform = 'translate3d(' + st.cx + 'px,' + st.cy + 'px,0)';
        }, 420);
      };
      cursor.style.transform = 'translate3d(' + spawn.x + 'px,' + spawn.y + 'px,0)';
      document.documentElement.append(host);
      st.raf = requestAnimationFrame(step);
    }
    const st = host.__broRelayState, cursor = root.querySelector('.cursor'),
      target = root.querySelector('.target'), label = root.querySelector('.label');
    cursor.classList.add('on');
    const px = args.x != null ? args.x : (document.__broRelayPointer || { x: viewport.width / 2 }).x,
      py = args.y != null ? args.y : (document.__broRelayPointer || { y: viewport.height / 2 }).y;
    if (args.x != null) { st.tx = args.x; st.ty = args.y; document.__broRelayPointer = { x: args.x, y: args.y }; st.snap(); }
    if (args.rect) {
      target.style.left = args.rect.x + 'px'; target.style.top = args.rect.y + 'px';
      target.style.width = Math.max(0, args.rect.width) + 'px'; target.style.height = Math.max(0, args.rect.height) + 'px';
      target.hidden = false;
      target.classList.remove('pop'); target.getBoundingClientRect(); target.classList.add('pop');
    } else if (op === 'show') target.hidden = true;
    if (args.label) {
      label.textContent = args.label; label.hidden = false;
      const box = label.getBoundingClientRect();
      let lx, ly;
      if (args.rect) {
        lx = clamp(args.rect.x + args.rect.width / 2 - box.width / 2, 8, viewport.width - box.width - 8);
        ly = args.rect.y - box.height - 8;
        if (ly < 8) ly = args.rect.y + args.rect.height + 8;
        ly = clamp(ly, 8, viewport.height - box.height - 8);
      } else {
        lx = px + 18; if (lx + box.width > viewport.width - 8) lx = px - box.width - 18;
        ly = py + 18; if (ly + box.height > viewport.height - 8) ly = py - box.height - 18;
        lx = clamp(lx, 8, viewport.width - box.width - 8);
        ly = clamp(ly, 8, viewport.height - box.height - 8);
      }
      label.style.left = lx + 'px'; label.style.top = ly + 'px';
    }
    if (op === 'ripple' && args.x != null) {
      cursor.classList.add('press');
      setTimeout(() => cursor.classList.remove('press'), 200);
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      const size = Math.max(0, Math.min(26, 2 * (Math.min(args.x, args.y, viewport.width - args.x, viewport.height - args.y) - 2) / 3));
      ripple.style.width = size + 'px'; ripple.style.height = size + 'px';
      ripple.style.margin = (-size / 2) + 'px';
      ripple.style.left = args.x + 'px'; ripple.style.top = args.y + 'px';
      root.append(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
      setTimeout(() => ripple.remove(), 700);
    }
    clearTimeout(host.__broRelayIdle);
    host.__broRelayIdle = setTimeout(() => { cancelAnimationFrame(st.raf); clearTimeout(st.snapTimer); host.remove(); }, ${operation === "ripple" ? OVERLAY_LIFETIME_MS.ripple : OVERLAY_LIFETIME_MS.show});
    return { ok: true, viewport };
  } catch (error) { return { ok: false, error: String((error && error.message) || error) }; } })()`;

const hint = (operation, args, pointer) => ({ expression: expression(operation, args), pointer });

export const showActionOverlay = (x, y, rect, label = "定位") =>
  hint("show", { x, y, label, ...(rect ? { rect } : {}) }, { x, y, label, rect: rect || null, kind: "move" });

export const rippleActionOverlay = (x, y) => hint("ripple", { x, y }, { x, y, kind: "click" });

export const dismissActionOverlay = () => hint("dismiss", {}, null);
