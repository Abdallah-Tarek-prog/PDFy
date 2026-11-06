// Moving around the pages the way Xodo allows: zoom with Ctrl and the wheel or a touchpad pinch,
// right where the pointer is; drag with the middle button to move in any direction; one finger
// moves and two fingers pinch on a touch screen. The wheel can be set to zoom on its own.

import { getSettings } from '../core/settings';
import type { Viewer } from './viewer';

export interface GestureHooks {
  /** True when a finger or the mouse should draw rather than move the page. */
  drawsWith(pointerType: string): boolean;
  /** Drops a stroke the first finger had begun, when a second finger turns it into a pinch. */
  cancelDrawing(): void;
}

export function installGestures(viewer: Viewer, hooks: GestureHooks) {
  const sc = viewer.scroller;

  // ---- Wheel and touchpad ----
  sc.addEventListener('wheel', e => {
    if (!viewer.session) return;
    const zoom = e.ctrlKey || e.metaKey || (getSettings().wheelZooms && !e.shiftKey && !e.altKey);
    if (!zoom) return;
    e.preventDefault();
    // A touchpad pinch arrives as many small steps, a mouse wheel as a few large ones.
    const lines = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const k = Math.abs(lines) < 40 ? 0.012 : 0.0018;
    viewer.zoomAt(viewer.scale * Math.exp(-lines * k), e.clientX, e.clientY);
  }, { passive: false });

  // ---- Middle button: drag to move in any direction ----
  sc.addEventListener('pointerdown', e => {
    if (e.button !== 1 || !viewer.session) return;
    e.preventDefault();
    e.stopPropagation();
    drag(e, 'mouse');
  }, true);
  // Stops Windows' auto-scroll circle from appearing.
  sc.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });

  // ---- Touch: one finger moves, two fingers pinch ----
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; scale: number; mx: number; my: number } | null = null;
  let flick = 0;
  let stopDrag: (() => void) | null = null;
  sc.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !viewer.session) return;
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
      drag(e, 'touch');
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
        drag({ pointerId, clientX: p.x, clientY: p.y }, 'touch');
      }
    }
  };
  window.addEventListener('pointerup', lift);
  window.addEventListener('pointercancel', lift);

  window.addEventListener('blur', () => {
    stopDrag?.();
    cancelAnimationFrame(flick);
    touches.clear();
    pinch = null;
  });

  /** Drags the page under the pointer, and lets a quick finger flick glide on. */
  function drag(e: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>, kind: 'mouse' | 'touch') {
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
      if (u.type === 'pointercancel' || kind !== 'touch' || pinch || performance.now() - lt > 80) return;
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
