// Best-effort, page-local visual feedback for agent actions.
export const ACTION_OVERLAY_SELECTOR = "[data-bro-relay-action-overlay]";

// A hint that disappears before the operator can look at the window is not
// feedback. Every action refreshes the timer, so one hint covers a whole batch.
// Screenshots dismiss it first, so it never lands in the agent's own evidence.
export const OVERLAY_LIFETIME_MS = { show: 1500, ripple: 1200, max: 1500 };

const expression = (operation, args = {}) =>
  `(() => { try { const key = ${JSON.stringify(ACTION_OVERLAY_SELECTOR)}, args = ${JSON.stringify(args)};
    if (${JSON.stringify(operation)} === 'dismiss') { const existing = document.querySelector(key); if (existing) { clearTimeout(existing.__broRelayIdle); existing.remove(); } return {ok:true,dismissed:!!existing}; }
    let host = document.querySelector(key), root = host && host.__broRelayRoot;
    if (!host) { host = document.createElement('div'); host.setAttribute('data-bro-relay-action-overlay',''); host.setAttribute('aria-hidden','true'); host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;'; root=host.attachShadow({mode:'closed'}); host.__broRelayRoot=root; const style=document.createElement('style'); style.textContent=':host{all:initial} .cursor{box-sizing:border-box;position:fixed;left:0;top:0;width:12px;height:16px;margin:0;border:0;background:#6366f180;clip-path:polygon(0 0,0 100%,30% 75%,50% 100%,65% 90%,45% 65%,90% 65%);will-change:transform;transform:translate3d(-40px,-40px,0) scale(.8);transition:transform 220ms cubic-bezier(.22,1,.36,1)} .label{position:fixed;box-sizing:border-box;max-width:calc(100vw - 16px);padding:4px 9px;border:1px solid #ffffff40;border-radius:999px;background:#312e81;color:white;font:500 12px/18px system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 8px #0002} .target{box-sizing:border-box;position:fixed;border:2px solid #2563eb;border-radius:6px;background:#2563eb18;box-shadow:0 0 0 2px #fff8;transition:all 120ms ease} .ripple{box-sizing:border-box;position:fixed;width:18px;height:18px;margin:-9px;border:1px solid #2563eb30;border-radius:50%;animation:ripple 360ms ease-out forwards}@keyframes ripple{to{transform:scale(3);opacity:0}} @media(prefers-reduced-motion:reduce){.cursor,.target{transition:none}.ripple{animation:none;opacity:0}}'; root.append(style); const target=document.createElement('div'), cursor=document.createElement('div'); target.className='target'; cursor.className='cursor'; const previous=document.__broRelayPointer; if(previous){cursor.style.transform='translate3d('+previous.x+'px,'+previous.y+'px,0) scale(.8)';} const label=document.createElement('div'); label.className='label'; label.hidden=true; root.append(target,cursor,label); document.documentElement.append(host); if(previous)cursor.getBoundingClientRect(); }
    const cursor = root.querySelector('.cursor'), target = root.querySelector('.target');
    if (args.x != null) { document.__broRelayPointer={x:args.x,y:args.y}; cursor.style.transform='translate3d('+args.x+'px,'+args.y+'px,0) scale(1)'; }
    if (args.rect) { target.style.left=args.rect.x+'px'; target.style.top=args.rect.y+'px'; target.style.width=Math.max(0,args.rect.width)+'px'; target.style.height=Math.max(0,args.rect.height)+'px'; target.hidden=false; } else if (${JSON.stringify(operation)} === 'show') target.hidden=true;
    if (args.label) {
      const label=root.querySelector('.label'); label.textContent=args.label; label.hidden=false;
      const box=label.getBoundingClientRect();
      label.style.left=(args.x<innerWidth/2 ? Math.max(8,innerWidth-box.width-8) : 8)+'px';
      label.style.top=(args.y<60 ? Math.max(8,innerHeight-box.height-8) : 8)+'px';
    }
    if (${JSON.stringify(operation)} === 'ripple' && args.x != null) { const ripple=document.createElement('div'); ripple.className='ripple'; const size=Math.max(0,Math.min(18,2*(Math.min(args.x,args.y,innerWidth-args.x,innerHeight-args.y)-2)/3)); ripple.style.width=size+'px'; ripple.style.height=size+'px'; ripple.style.margin=(-size/2)+'px'; ripple.style.left=args.x+'px'; ripple.style.top=args.y+'px'; root.append(ripple); ripple.addEventListener('animationend',()=>ripple.remove(),{once:true}); setTimeout(()=>ripple.remove(),500); }
    clearTimeout(host.__broRelayIdle); host.__broRelayIdle=setTimeout(()=>{ host.remove(); }, ${operation === "ripple" ? OVERLAY_LIFETIME_MS.ripple : OVERLAY_LIFETIME_MS.show});
    return {ok:true};
  } catch (error) { return {ok:false,error:String((error && error.message) || error)}; } })()`;

export const showActionOverlay = (x, y, rect, label = "定位") =>
  expression("show", { x, y, label, ...(rect ? { rect } : {}) });

export const rippleActionOverlay = (x, y) => expression("ripple", { x, y });

export const dismissActionOverlay = () => expression("dismiss", {});
