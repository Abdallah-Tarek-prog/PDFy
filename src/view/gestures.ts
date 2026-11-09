// Moving around the pages the way Xodo allows: zoom with Ctrl and the wheel or a touchpad pinch,
// right where the pointer is; click the middle button for pointer-controlled scrolling; one finger
// moves and two fingers pinch on a touch screen. The wheel can be set to zoom on its own.

import { getSettings } from '../core/settings';
import { h, icon } from '../ui/dom';
import type { Viewer } from './viewer';

export interface GestureHooks {
  /** True when a finger or the mouse should draw rather than move the page. */
  drawsWith(pointerType: string): boolean;
  /** Drops a stroke the first finger had begun, when a second finger turns it into a pinch. */
  cancelDrawing(): void;
}

export function installGestures(viewer: Viewer, hooks: GestureHooks) {
  const sc = viewer.scroller;
  let auto: { session: Viewer['session']; x: number; y: number; originX: number; originY: number; marker: HTMLElement } | null = null;
  let autoFrame = 0;

  function stopAutoScroll() {
    cancelAnimationFrame(autoFrame);
    auto?.marker.remove(); auto = null;
    sc.classList.remove('auto-scrolling');
  }

  function startAutoScroll(e: PointerEvent) {
    hooks.cancelDrawing(); stopDrag?.(); cancelAnimationFrame(flick);
    const marker = h('div', { class: 'auto-scroll-origin', 'aria-hidden': 'true', style: { left: `${e.clientX}px`, top: `${e.clientY}px` } }, icon('autoScroll', 18));
    document.body.append(marker);
    auto = { session: viewer.session, x: e.clientX, y: e.clientY, originX: e.clientX, originY: e.clientY, marker };
    sc.classList.add('auto-scrolling');
    let last = performance.now();
    const speed = (delta: number) => Math.sign(delta) * Math.min(1800, Math.pow(Math.max(0, Math.abs(delta) - 10), 1.3) * 1.8);
    const frame = (now: number) => {
      if (!auto || viewer.session !== auto.session || !sc.isConnected || document.hidden) { stopAutoScroll(); return; }
      const seconds = Math.min(32, now - last) / 1000; last = now;
      sc.scrollLeft += speed(auto.x - auto.originX) * seconds;
      sc.scrollTop += speed(auto.y - auto.originY) * seconds;
      autoFrame = requestAnimationFrame(frame);
    };
    autoFrame = requestAnimationFrame(frame);
  }

  window.addEventListener('pointermove', e => { if (auto && e.pointerType === 'mouse') { auto.x = e.clientX; auto.y = e.clientY; } }, true);
  window.addEventListener('pointerdown', e => {
    if (!auto) return;
    stopAutoScroll();
    // A second wheel click stops scrolling, including when it lands in the other pane.
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('keydown', e => {
    if (!auto || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    stopAutoScroll();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAutoScroll(); });

  // Native pinch must reach the page, but it must never magnify toolbars, panels or Home.
  window.addEventListener('wheel', e => {
    if ((e.ctrlKey || e.metaKey) && (!viewer.session || !sc.contains(e.target as Node))) e.preventDefault();
  }, { capture: true, passive: false });

  // ---- Wheel and touchpad ----
  // Two-finger scrolling on a touchpad is left to the browser, which moves freely in both
  // directions. A touchpad pinch arrives as a wheel event marked with Ctrl, although no Ctrl key
  // is down; Ctrl+wheel with the real key held is the mouse. Each kind zooms by a fixed rate per
  // pixel, so the same movement zooms the same however the browser splits it into events.
  let ctrlHeld = false;
  const track = (e: KeyboardEvent | PointerEvent) => { ctrlHeld = e.ctrlKey || e.metaKey; };
  window.addEventListener('keydown', track, true);
  window.addEventListener('keyup', track, true);
  window.addEventListener('pointermove', track, true);
  sc.addEventListener('wheel', e => {
    if (!viewer.session) return;
    stopAutoScroll();
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const pinch = (e.ctrlKey || e.metaKey) && !ctrlHeld;
    // "The wheel zooms" is meant for a mouse wheel, so movement that looks like a touchpad's (sideways,
    // or small and fractional) keeps scrolling. This only chooses between scroll and zoom.
    const wheelLike = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
    const zoom = e.ctrlKey || e.metaKey || (getSettings().wheelZooms && wheelLike && !e.shiftKey && !e.altKey);
    if (!zoom) return;
    e.preventDefault();
    // A pinch's pixels are the browser's own measure of the fingers' movement, so they map straight
    // to scale. A mouse wheel click of 100 pixels is about a 20% step.
    viewer.zoomAt(viewer.scale * Math.exp(-px * (pinch ? 0.01 : 0.0018)), e.clientX, e.clientY);
  }, { passive: false });

  // ---- Middle button: click once to scroll with the pointer, click again to stop ----
  sc.addEventListener('pointerdown', e => {
    if (e.button !== 1 || !viewer.session) return;
    if ((e.target as Element).closest('input, textarea, select, button, a, [contenteditable=true], .inline-editor')) return;
    e.preventDefault();
    e.stopPropagation();
    startAutoScroll(e);
  }, true);
  // Use our own toggle consistently in the browser and Windows host.
  sc.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  sc.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });

  // ---- Touch: one finger moves, two fingers pinch ----
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; scale: number; mx: number; my: number } | null = null;
  let flick = 0;
  let stopDrag: (() => void) | null = null;
  sc.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !viewer.session) return;
    if ((e.target as Element).closest('.markdown-editor')) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(flick);
    if (touches.size === 2) {
      stopDrag?.();
      const [a, b] = [...touches.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: viewer.scale, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      // A second finger means a pinch, never a drawing.
      e.stopPropagation();
      hooks.cancelDrawing();
      return;
    }
    if (touches.size === 1 && !hooks.drawsWith('touch')) {
      e.stopPropagation();
      drag(e);
    }
  }, true);
  window.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      viewer.zoomAt(pinch.scale * (dist / pinch.dist), mx, my);
      sc.scrollLeft -= mx - pinch.mx;
      sc.scrollTop -= my - pinch.my;
      pinch.mx = mx; pinch.my = my;
    }
  });
  const lift = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const wasPinching = pinch !== null;
    touches.delete(e.pointerId);
    if (touches.size < 2) {
      pinch = null;
      // Continue from the finger's current position, rather than its position before the pinch.
      if (wasPinching && touches.size === 1 && e.type !== 'pointercancel') {
        const [pointerId, p] = [...touches][0];
        drag({ pointerId, clientX: p.x, clientY: p.y });
      }
    }
  };
  window.addEventListener('pointerup', lift);
  window.addEventListener('pointercancel', lift);

  window.addEventListener('blur', () => {
    stopAutoScroll();
    ctrlHeld = false;
    stopDrag?.();
    cancelAnimationFrame(flick);
    touches.clear();
    pinch = null;
  });

  /** Drags the page under the pointer, and lets a quick finger flick glide on. */
  function drag(e: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>) {
    stopDrag?.();
    cancelAnimationFrame(flick);
    const id = e.pointerId;
    let lx = e.clientX, ly = e.clientY, vx = 0, vy = 0, lt = performance.now();
    sc.classList.add('panning');
    const move = (m: PointerEvent) => {
      if (m.pointerId !== id || pinch) return;
      const now = performance.now(), dt = Math.max(1, now - lt);
      const dx = m.clientX - lx, dy = m.clientY - ly;
      sc.scrollLeft -= dx;
      sc.scrollTop -= dy;
      vx = dx / dt; vy = dy / dt;
      lx = m.clientX; ly = m.clientY; lt = now;
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== id) return;
      stop();
      if (u.type === 'pointercancel' || pinch || performance.now() - lt > 80) return;
      // Glide, slowing down smoothly.
      let last = performance.now();
      const glide = () => {
        const now = performance.now(), dt = now - last;
        last = now;
        vx *= Math.pow(0.94, dt / 16); vy *= Math.pow(0.94, dt / 16);
        if (Math.hypot(vx, vy) < 0.02) return;
        sc.scrollLeft -= vx * dt; sc.scrollTop -= vy * dt;
        flick = requestAnimationFrame(glide);
      };
      flick = requestAnimationFrame(glide);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      sc.classList.remove('panning');
      if (stopDrag === stop) stopDrag = null;
    };
    stopDrag = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
}
