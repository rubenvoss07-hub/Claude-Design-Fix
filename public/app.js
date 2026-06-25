'use strict';

/*
 * Cursor Control — front-end controller.
 *
 * The proxied site is loaded same-origin inside #frame, which lets us reach
 * into its document and dispatch real MOUSE / POINTER(mouse) events. Touches on
 * the right-hand pane are captured by a transparent overlay and translated into
 * those mouse events, so the page behaves as if driven by a desktop mouse.
 */
(function () {
  // ---- element refs ----
  const app = document.querySelector('.app');
  const frame = document.getElementById('frame');
  const overlay = document.getElementById('overlay');
  const cursor = document.getElementById('cursor');
  const viewport = document.getElementById('viewport');
  const welcome = document.getElementById('welcome');
  const loadbar = document.getElementById('loadbar');
  const toastEl = document.getElementById('toast');

  const urlForm = document.getElementById('urlForm');
  const urlInput = document.getElementById('urlInput');
  const backBtn = document.getElementById('backBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const homeBtn = document.getElementById('homeBtn');

  const dpadClick = document.getElementById('dpadClick');
  const clickBtn = document.getElementById('clickBtn');
  const dblClickBtn = document.getElementById('dblClickBtn');
  const rightClickBtn = document.getElementById('rightClickBtn');
  const dragBtn = document.getElementById('dragBtn');
  const scrollUpBtn = document.getElementById('scrollUpBtn');
  const scrollDownBtn = document.getElementById('scrollDownBtn');

  const trackpad = document.getElementById('trackpad');
  const modeSeg = document.getElementById('modeSeg');
  const speed = document.getElementById('speed');
  const cursorSize = document.getElementById('cursorSize');

  const collapseBtn = document.getElementById('collapseBtn');
  const revealBtn = document.getElementById('revealBtn');

  // ---- state ----
  let cx = 0;
  let cy = 0;
  let speedVal = parseInt(speed.value, 10) || 9;
  let mode = 'direct'; // 'direct' | 'trackpad'
  let dragging = false;
  let cursorInitialized = false;
  let lastHoverEl = null;

  const TAP_MOVE = 8; // px of movement still counted as a tap
  const TAP_TIME = 400; // ms

  function trackpadGain() {
    return 0.6 + speedVal / 12;
  }
  function dpadStep() {
    return 1.5 + speedVal;
  }
  function scrollSpeed() {
    return 8 + speedVal * 2;
  }

  // ---- same-origin frame access ----
  function getWin() {
    try {
      return frame.contentWindow || null;
    } catch (e) {
      return null;
    }
  }
  function getDoc() {
    try {
      return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
    } catch (e) {
      return null;
    }
  }

  // ---- event synthesis ----
  function makeEvent(win, type, o) {
    const isPointer = type.indexOf('pointer') === 0;
    const isWheel = type === 'wheel';
    const Ctor = isPointer
      ? win.PointerEvent || win.MouseEvent
      : isWheel
      ? win.WheelEvent || win.MouseEvent
      : win.MouseEvent;

    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX: o.x,
      clientY: o.y,
      screenX: o.x,
      screenY: o.y,
      button: o.button || 0,
      buttons: o.buttons || 0,
      detail: o.detail || 0,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    };
    if (isPointer) {
      init.pointerId = 1;
      init.pointerType = 'mouse';
      init.isPrimary = true;
      init.width = 1;
      init.height = 1;
      init.pressure = o.buttons ? 0.5 : 0;
    }
    if (isWheel) {
      init.deltaX = o.deltaX || 0;
      init.deltaY = o.deltaY || 0;
      init.deltaMode = 0;
    }
    try {
      return new Ctor(type, init);
    } catch (e) {
      try {
        return new win.MouseEvent(type, init);
      } catch (e2) {
        return null;
      }
    }
  }

  function fire(el, win, type, o) {
    if (!el || !win) return null;
    const ev = makeEvent(win, type, o);
    if (ev) {
      try {
        el.dispatchEvent(ev);
      } catch (e) {}
    }
    return ev;
  }

  function focusEl(el) {
    try {
      const tag = (el.tagName || '').toLowerCase();
      if (
        el.isContentEditable ||
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        tag === 'button' ||
        tag === 'a' ||
        (typeof el.tabIndex === 'number' && el.tabIndex >= 0)
      ) {
        el.focus({ preventScroll: true });
      }
    } catch (e) {}
  }

  // ---- hover / move ----
  function hoverMove(x, y) {
    const win = getWin();
    const doc = getDoc();
    if (!win || !doc) return;
    let el;
    try {
      el = doc.elementFromPoint(x, y);
    } catch (e) {
      return;
    }
    if (el !== lastHoverEl) {
      if (lastHoverEl) {
        fire(lastHoverEl, win, 'pointerout', { x, y });
        fire(lastHoverEl, win, 'mouseout', { x, y });
        fire(lastHoverEl, win, 'pointerleave', { x, y });
        fire(lastHoverEl, win, 'mouseleave', { x, y });
      }
      if (el) {
        fire(el, win, 'pointerover', { x, y });
        fire(el, win, 'mouseover', { x, y });
        fire(el, win, 'pointerenter', { x, y });
        fire(el, win, 'mouseenter', { x, y });
      }
      lastHoverEl = el;
    }
    if (el) {
      const buttons = dragging ? 1 : 0;
      fire(el, win, 'pointermove', { x, y, buttons });
      fire(el, win, 'mousemove', { x, y, buttons });
    }
  }

  // ---- click / dblclick / right-click ----
  function clickAt(x, y, button) {
    const win = getWin();
    const doc = getDoc();
    if (!win || !doc) {
      toast('Load a website first');
      return;
    }
    let el;
    try {
      el = doc.elementFromPoint(x, y);
    } catch (e) {
      return;
    }
    el = el || doc.body;
    if (!el) return;

    hoverMove(x, y);
    const btn = button || 0;
    const mask = btn === 2 ? 2 : 1;

    fire(el, win, 'pointerdown', { x, y, button: btn, buttons: mask });
    fire(el, win, 'mousedown', { x, y, button: btn, buttons: mask });
    focusEl(el);
    fire(el, win, 'pointerup', { x, y, button: btn, buttons: 0 });
    fire(el, win, 'mouseup', { x, y, button: btn, buttons: 0 });

    if (btn === 2) {
      fire(el, win, 'contextmenu', { x, y, button: 2, buttons: 0 });
    } else {
      fire(el, win, 'click', { x, y, button: 0, buttons: 0, detail: 1 });
    }
    rippleAt(x, y);
    flashCursor('clicking');
  }

  function dblClickAt(x, y) {
    clickAt(x, y, 0);
    clickAt(x, y, 0);
    const win = getWin();
    const doc = getDoc();
    if (!win || !doc) return;
    let el;
    try {
      el = doc.elementFromPoint(x, y) || doc.body;
    } catch (e) {
      return;
    }
    fire(el, win, 'dblclick', { x, y, detail: 2 });
  }

  // ---- drag ----
  function startDrag() {
    const win = getWin();
    const doc = getDoc();
    if (!win || !doc) {
      toast('Load a website first');
      return;
    }
    let el;
    try {
      el = doc.elementFromPoint(cx, cy) || doc.body;
    } catch (e) {
      return;
    }
    hoverMove(cx, cy);
    fire(el, win, 'pointerdown', { x: cx, y: cy, button: 0, buttons: 1 });
    fire(el, win, 'mousedown', { x: cx, y: cy, button: 0, buttons: 1 });
    dragging = true;
    updateDragUI();
  }
  function endDrag() {
    const win = getWin();
    const doc = getDoc();
    if (win && doc) {
      let el;
      try {
        el = doc.elementFromPoint(cx, cy) || doc.body;
      } catch (e) {
        el = doc.body;
      }
      fire(el, win, 'pointerup', { x: cx, y: cy, button: 0, buttons: 0 });
      fire(el, win, 'mouseup', { x: cx, y: cy, button: 0, buttons: 0 });
      fire(el, win, 'click', { x: cx, y: cy, button: 0, buttons: 0, detail: 1 });
    }
    dragging = false;
    updateDragUI();
  }
  function toggleDrag() {
    dragging ? endDrag() : startDrag();
  }
  function updateDragUI() {
    cursor.classList.toggle('dragging', dragging);
    dragBtn.classList.toggle('on', dragging);
    dragBtn.textContent = 'Drag: ' + (dragging ? 'on' : 'off');
  }

  // ---- scroll ----
  function scrollAt(x, y, dx, dy) {
    const win = getWin();
    const doc = getDoc();
    if (!win || !doc) return;
    let el;
    try {
      el = doc.elementFromPoint(x, y);
    } catch (e) {
      el = null;
    }
    el = el || doc.scrollingElement || doc.body;
    fire(el || doc.body, win, 'wheel', { x, y, deltaX: dx, deltaY: dy });

    let node = el;
    while (node && node.nodeType === 1 && node !== doc.body && node !== doc.documentElement) {
      let cs;
      try {
        cs = win.getComputedStyle(node);
      } catch (e) {
        break;
      }
      const oy = cs.overflowY;
      const ox = cs.overflowX;
      const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight;
      const canX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && node.scrollWidth > node.clientWidth;
      if (canY || canX) {
        node.scrollLeft += dx;
        node.scrollTop += dy;
        return;
      }
      node = node.parentElement;
    }
    try {
      win.scrollBy(dx, dy);
    } catch (e) {
      try {
        (doc.scrollingElement || doc.body).scrollTop += dy;
      } catch (e2) {}
    }
  }

  // ---- cursor positioning ----
  let hoverScheduled = false;
  function setCursor(x, y) {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    cx = Math.max(0, Math.min(w, x));
    cy = Math.max(0, Math.min(h, y));
    cursor.style.left = cx + 'px';
    cursor.style.top = cy + 'px';
    if (!hoverScheduled) {
      hoverScheduled = true;
      requestAnimationFrame(function () {
        hoverScheduled = false;
        if (getDoc()) hoverMove(cx, cy);
      });
    }
  }
  function moveCursorBy(dx, dy) {
    setCursor(cx + dx, cy + dy);
  }

  // ---- visual feedback ----
  function rippleAt(x, y) {
    const r = document.createElement('div');
    r.className = 'cursor-ripple';
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    viewport.appendChild(r);
    setTimeout(function () {
      r.remove();
    }, 480);
  }
  function flashCursor(cls) {
    cursor.classList.add(cls);
    setTimeout(function () {
      cursor.classList.remove(cls);
    }, 150);
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2400);
  }

  let loadTimer = null;
  function showLoad() {
    loadbar.classList.add('active');
    loadbar.style.width = '15%';
    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      loadbar.style.width = '75%';
    }, 250);
  }
  function hideLoad() {
    loadbar.style.width = '100%';
    setTimeout(function () {
      loadbar.classList.remove('active');
      loadbar.style.width = '0%';
    }, 250);
  }

  // ---- URL handling ----
  function normalizeUrl(input) {
    let u = (input || '').trim();
    if (!u) return null;
    // Same-origin path (e.g. the built-in /demo.html).
    if (u.charAt(0) === '/') return location.origin + u;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      return new URL(u).href;
    } catch (e) {
      return null;
    }
  }
  function loadUrl(input) {
    const abs = normalizeUrl(input);
    if (!abs) {
      toast('Please enter a valid address');
      return;
    }
    welcome.classList.add('hidden');
    showLoad();
    urlInput.value = abs;
    frame.src = '/proxy?url=' + encodeURIComponent(abs);
  }

  frame.addEventListener('load', function () {
    hideLoad();
    lastHoverEl = null;
    if (!frame.src || frame.src === 'about:blank') return;

    // Sync the address bar from the proxied location.
    try {
      const loc = frame.contentWindow.location.href;
      const m = /[?&]url=([^&]+)/.exec(loc);
      if (m) urlInput.value = decodeURIComponent(m[1]);
    } catch (e) {}

    if (!cursorInitialized) {
      setCursor(viewport.clientWidth / 2, viewport.clientHeight / 2);
      cursorInitialized = true;
    }
    // Confirm we actually have control of the document.
    if (!getDoc()) {
      toast('This site blocked embedded control.');
    }
  });

  // The injected shim posts the real (un-proxied) URL once it loads.
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (d && d.__cdf === 'loaded' && typeof d.url === 'string') {
      urlInput.value = d.url;
    }
  });

  // ---- overlay (the right pane is a giant trackpad/touch surface) ----
  const pointers = new Map();
  let twoFingerLast = null;

  function clientToVp(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }
  function centroid() {
    let x = 0;
    let y = 0;
    let n = 0;
    pointers.forEach(function (p) {
      x += p.lx;
      y += p.ly;
      n++;
    });
    return n ? { x: x / n, y: y / n } : { x: cx, y: cy };
  }

  overlay.addEventListener('pointerdown', function (e) {
    overlay.setPointerCapture(e.pointerId);
    const p = clientToVp(e.clientX, e.clientY);
    pointers.set(e.pointerId, {
      sx: p.x,
      sy: p.y,
      lx: p.x,
      ly: p.y,
      t: performance.now(),
      moved: false,
    });
    if (pointers.size === 1 && mode === 'direct') setCursor(p.x, p.y);
    if (pointers.size === 2) twoFingerLast = centroid();
    e.preventDefault();
  });

  overlay.addEventListener('pointermove', function (e) {
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    const p = clientToVp(e.clientX, e.clientY);
    const dx = p.x - rec.lx;
    const dy = p.y - rec.ly;
    rec.lx = p.x;
    rec.ly = p.y;
    if (Math.abs(p.x - rec.sx) > TAP_MOVE || Math.abs(p.y - rec.sy) > TAP_MOVE) rec.moved = true;

    if (pointers.size >= 2) {
      const c = centroid();
      if (twoFingerLast) scrollAt(cx, cy, -(c.x - twoFingerLast.x), -(c.y - twoFingerLast.y));
      twoFingerLast = c;
      e.preventDefault();
      return;
    }

    if (mode === 'direct') setCursor(p.x, p.y);
    else moveCursorBy(dx * trackpadGain(), dy * trackpadGain());
    e.preventDefault();
  });

  function overlayEnd(e) {
    const rec = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    try {
      overlay.releasePointerCapture(e.pointerId);
    } catch (er) {}
    if (pointers.size < 2) twoFingerLast = null;
    if (rec) {
      const dt = performance.now() - rec.t;
      if (!rec.moved && dt < TAP_TIME && pointers.size === 0) clickAt(cx, cy, 0);
    }
    e.preventDefault();
  }
  overlay.addEventListener('pointerup', overlayEnd);
  overlay.addEventListener('pointercancel', overlayEnd);
  overlay.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });
  overlay.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      scrollAt(cx, cy, e.deltaX, e.deltaY);
    },
    { passive: false }
  );

  // ---- sidebar trackpad (relative move + tap to click) ----
  let tpRec = null;
  trackpad.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    trackpad.setPointerCapture(e.pointerId);
    trackpad.classList.add('active');
    tpRec = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), moved: false };
  });
  trackpad.addEventListener('pointermove', function (e) {
    if (!tpRec) return;
    const dx = e.clientX - tpRec.lx;
    const dy = e.clientY - tpRec.ly;
    tpRec.lx = e.clientX;
    tpRec.ly = e.clientY;
    if (Math.abs(e.clientX - tpRec.sx) > TAP_MOVE || Math.abs(e.clientY - tpRec.sy) > TAP_MOVE) tpRec.moved = true;
    moveCursorBy(dx * trackpadGain(), dy * trackpadGain());
  });
  function tpEnd() {
    trackpad.classList.remove('active');
    if (tpRec) {
      const dt = performance.now() - tpRec.t;
      if (!tpRec.moved && dt < TAP_TIME) clickAt(cx, cy, 0);
    }
    tpRec = null;
  }
  trackpad.addEventListener('pointerup', tpEnd);
  trackpad.addEventListener('pointercancel', tpEnd);

  // ---- D-pad (press and hold to move continuously) ----
  const activeDirs = new Set();
  let moveRAF = null;
  function dirVec() {
    let dx = 0;
    let dy = 0;
    if (activeDirs.has('up')) dy -= 1;
    if (activeDirs.has('down')) dy += 1;
    if (activeDirs.has('left')) dx -= 1;
    if (activeDirs.has('right')) dx += 1;
    return { dx, dy };
  }
  function moveTick() {
    const v = dirVec();
    if (v.dx || v.dy) {
      const step = dpadStep();
      moveCursorBy(v.dx * step, v.dy * step);
      moveRAF = requestAnimationFrame(moveTick);
    } else {
      moveRAF = null;
    }
  }
  function startDir(dir) {
    activeDirs.add(dir);
    if (!moveRAF) moveRAF = requestAnimationFrame(moveTick);
  }
  function stopDir(dir) {
    activeDirs.delete(dir);
  }
  document.querySelectorAll('.dpad-btn[data-dir]').forEach(function (btn) {
    const dir = btn.getAttribute('data-dir');
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (er) {}
      startDir(dir);
    });
    const stop = function () {
      stopDir(dir);
    };
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
  });

  // ---- hold-to-repeat helper (scroll buttons) ----
  function holdRepeat(btn, fn) {
    let raf = null;
    function tick() {
      fn();
      raf = requestAnimationFrame(tick);
    }
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (er) {}
      if (!raf) {
        fn();
        raf = requestAnimationFrame(tick);
      }
    });
    function stop() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    }
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
  }
  holdRepeat(scrollUpBtn, function () {
    scrollAt(cx, cy, 0, -scrollSpeed());
  });
  holdRepeat(scrollDownBtn, function () {
    scrollAt(cx, cy, 0, scrollSpeed());
  });

  // ---- action buttons ----
  dpadClick.addEventListener('click', function () {
    clickAt(cx, cy, 0);
  });
  clickBtn.addEventListener('click', function () {
    clickAt(cx, cy, 0);
  });
  dblClickBtn.addEventListener('click', function () {
    dblClickAt(cx, cy);
  });
  rightClickBtn.addEventListener('click', function () {
    clickAt(cx, cy, 2);
  });
  dragBtn.addEventListener('click', toggleDrag);

  // ---- settings ----
  modeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.getAttribute('data-mode');
      modeSeg.querySelectorAll('.seg-btn').forEach(function (x) {
        x.classList.toggle('active', x === b);
      });
      toast(mode === 'direct' ? 'Direct: cursor follows your finger' : 'Trackpad: drag to nudge the cursor');
    });
  });
  speed.addEventListener('input', function () {
    speedVal = parseInt(speed.value, 10) || 9;
  });
  cursorSize.addEventListener('input', function () {
    const s = parseInt(cursorSize.value, 10) || 28;
    cursor.style.width = s + 'px';
    cursor.style.height = s + 'px';
  });

  // ---- navigation ----
  urlForm.addEventListener('submit', function (e) {
    e.preventDefault();
    loadUrl(urlInput.value);
    urlInput.blur();
  });
  backBtn.addEventListener('click', function () {
    try {
      frame.contentWindow.history.back();
    } catch (e) {
      toast('Nothing to go back to');
    }
  });
  reloadBtn.addEventListener('click', function () {
    try {
      frame.contentWindow.location.reload();
    } catch (e) {
      if (frame.src) {
        const s = frame.src;
        frame.src = s;
      }
    }
  });
  homeBtn.addEventListener('click', function () {
    frame.src = 'about:blank';
    welcome.classList.remove('hidden');
    urlInput.value = '';
  });

  document.querySelectorAll('[data-url]').forEach(function (el) {
    el.addEventListener('click', function () {
      loadUrl(el.getAttribute('data-url'));
    });
  });

  // ---- collapse / reveal sidebar ----
  collapseBtn.addEventListener('click', function () {
    app.classList.add('collapsed');
  });
  revealBtn.addEventListener('click', function () {
    app.classList.remove('collapsed');
  });

  // ---- keyboard (desktop convenience) ----
  window.addEventListener('keydown', function (e) {
    if (document.activeElement === urlInput) return;
    const step = 12 + speedVal;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
        moveCursorBy(0, -step);
        break;
      case 'ArrowDown':
        moveCursorBy(0, step);
        break;
      case 'ArrowLeft':
        moveCursorBy(-step, 0);
        break;
      case 'ArrowRight':
        moveCursorBy(step, 0);
        break;
      case 'Enter':
        clickAt(cx, cy, 0);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  });

  // ---- resize keeps the cursor inside bounds ----
  window.addEventListener('resize', function () {
    setCursor(cx, cy);
  });

  // ---- init ----
  setCursor(viewport.clientWidth / 2, viewport.clientHeight / 2);
})();
