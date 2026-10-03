/*
 * web-designer client overlay — injected into browser navigations by server.js.
 *
 * Everything lives in a shadow root so the design's own CSS can never style it
 * and it can never style the design. The page's DOM is untouched except while
 * a text edit is in progress (one contenteditable attribute, restored after).
 *
 * Talks to the server over ws://<host>/__designer/ws:
 *   out  hello | navigate | unload | element.selected | text.edited |
 *        text.cancelled | mode | result | error
 *   in   refresh | mode | highlight | exec | screenshot | server-stopping
 */
(function () {
  'use strict';
  if (window.__WEB_DESIGNER__) return;

  var MARQUEE_THRESHOLD = 6; // px of travel before a click becomes a drag
  var state = {
    mode: 'off', // 'off' | 'element' | 'text'
    ws: null,
    connected: false,
    retry: 0,
    hover: null,
    drag: null,
    edit: null,
    request: null,
  };

  /* ------------------------------------------------------------- overlay ui */

  var host = document.createElement('div');
  host.id = '__web_designer__';
  host.setAttribute('data-web-designer', 'ui');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  var shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.layer{position:fixed;inset:0;pointer-events:none}',
    /* toolbar */
    '.bar{position:fixed;left:16px;bottom:16px;display:flex;align-items:center;gap:2px;padding:4px;',
    '  background:rgba(23,23,23,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
    '  border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.4);',
    '  pointer-events:auto;user-select:none;color:#ededed;font-size:12px;line-height:1}',
    '.grip{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:grab;border-radius:8px}',
    '.grip:active{cursor:grabbing}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.18);',
    '  transition:background .2s,box-shadow .2s;flex:none}',
    '.dot.idle{background:#eab308;box-shadow:0 0 0 3px rgba(234,179,8,.18)}',
    '.dot.listening{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}',
    '.dot.working{width:11px;height:11px;background:transparent;box-shadow:none;border-radius:50%;',
    '  border:2px solid rgba(255,255,255,.22);border-top-color:#38bdf8;animation:wd-spin .7s linear infinite}',
    '@keyframes wd-spin{to{transform:rotate(360deg)}}',
    '.name{font-weight:600;letter-spacing:.2px;font-size:11px;color:#a1a1a1;white-space:nowrap}',
    '.state{font-size:11px;color:#6f6f6f;white-space:nowrap;max-width:15ch;overflow:hidden;text-overflow:ellipsis}',
    '.state.busy{color:#7dd3fc}',
    '.sep{width:1px;height:18px;background:rgba(255,255,255,.12);margin:0 3px}',
    'button{display:flex;align-items:center;gap:6px;padding:7px 10px;border:0;border-radius:8px;background:transparent;',
    '  color:#d4d4d4;font-size:12px;font-weight:500;cursor:pointer;transition:background .12s,color .12s}',
    'button:hover{background:rgba(255,255,255,.09);color:#fff}',
    'button.active{background:#ededed;color:#171717}',
    'button svg{width:14px;height:14px;display:block}',
    '.hint{position:fixed;left:50%;transform:translateX(-50%);bottom:76px;padding:6px 12px;border-radius:8px;',
    '  background:rgba(23,23,23,.92);color:#ededed;font-size:12px;border:1px solid rgba(255,255,255,.14);',
    '  box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .15s}',
    '.hint.show{opacity:1}',
    /* selection visuals */
    '.outline{position:fixed;border:2px dashed #0ea5e9;border-radius:2px;background:rgba(14,165,233,.08);pointer-events:none;display:none}',
    '.outline.solid{border-style:solid;border-color:#22c55e;background:rgba(34,197,94,.10)}',
    '.tag{position:fixed;padding:3px 6px;border-radius:5px;background:#0ea5e9;color:#fff;font-size:10px;',
    '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;pointer-events:none;display:none}',
    '.tag.solid{background:#22c55e}',
    '.marquee{position:fixed;border:1.5px solid #0ea5e9;background:rgba(14,165,233,.12);pointer-events:none;display:none}',
    '.textbox{position:fixed;background:rgba(250,204,21,.28);outline:1.5px solid rgba(234,179,8,.9);pointer-events:none;border-radius:2px}',
    /* edit confirm */
    '.confirm{position:fixed;display:flex;gap:4px;padding:4px;border-radius:10px;background:rgba(23,23,23,.94);',
    '  border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 30px rgba(0,0,0,.4);pointer-events:auto}',
    '.confirm button{font-size:14px;padding:6px 9px}',
    '.confirm .no:hover{background:rgba(239,68,68,.2)}',
    '.confirm .yes:hover{background:rgba(34,197,94,.2)}',
    /* element request panel */
    '.request{position:fixed;display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:12px;',
    '  background:rgba(23,23,23,.96);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
    '  border:1px solid rgba(255,255,255,.16);box-shadow:0 12px 40px rgba(0,0,0,.5);',
    '  pointer-events:auto;width:min(440px,calc(100vw - 32px))}',
    '.request .sel{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:#22c55e;',
    '  padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}',
    '.request .row{display:flex;gap:6px;align-items:flex-end}',
    '.request textarea{flex:1;resize:none;min-height:42px;max-height:180px;padding:10px;border-radius:8px;',
    '  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#ededed;',
    '  font-size:13px;line-height:1.45;font-family:inherit;outline:none}',
    '.request textarea::placeholder{color:#8a8a8a}',
    '.request textarea:focus{border-color:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.16)}',
    '.request .keys{font-size:10px;color:#8a8a8a;padding:0 2px}',
    '.request .actions{display:flex;gap:4px}',
    '.request .actions button{font-size:14px;padding:8px 9px}',
    '.request .no:hover{background:rgba(239,68,68,.2)}',
    '.request .yes:hover{background:rgba(34,197,94,.2)}',
    /* offline notice — shown when nothing is listening to what the user does */
    '.offline{position:fixed;inset:0;display:none;align-items:flex-start;justify-content:center;',
    '  background:rgba(10,10,10,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);pointer-events:auto}',
    '.offline.show{display:flex}',
    '.offline .card{margin-top:14vh;max-width:min(420px,calc(100vw - 32px));padding:18px 20px;border-radius:14px;',
    '  background:rgba(23,23,23,.97);border:1px solid rgba(255,255,255,.16);box-shadow:0 20px 60px rgba(0,0,0,.55);',
    '  color:#ededed;text-align:center}',
    '.offline h2{font-size:14px;font-weight:600;margin-bottom:8px;letter-spacing:.2px}',
    '.offline p{font-size:12.5px;line-height:1.55;color:#a1a1a1}',
    '.offline .say{display:inline-block;margin-top:10px;padding:6px 10px;border-radius:8px;',
    '  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#ededed;',
    '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
    '.offline .dismiss{margin:14px auto 0;font-size:11px;color:#8a8a8a;padding:5px 10px}',
    '.offline .dismiss:hover{background:rgba(255,255,255,.09);color:#d4d4d4}',
    '</style>',
    '<div class="layer" id="layer">',
    '  <div class="outline" id="outline"></div>',
    '  <div class="tag" id="tag"></div>',
    '  <div class="marquee" id="marquee"></div>',
    '</div>',
    '<div class="hint" id="hint"></div>',
    '<div class="offline" id="offline">',
    '  <div class="card">',
    '    <h2 id="offline-title">The assistant is disconnected</h2>',
    '    <p id="offline-body">Nothing you click or type on this page is reaching it right now.</p>',
    '    <span class="say">say &ldquo;resume&rdquo; in your chat</span>',
    '    <button class="dismiss" id="offline-dismiss">Dismiss and keep looking</button>',
    '  </div>',
    '</div>',
    '<div class="bar" id="bar">',
    '  <div class="grip" id="grip" title="designer"><span class="dot" id="dot"></span><span class="name">designer</span>',
    '    <span class="state" id="state">connecting</span></div>',
    '  <div class="sep"></div>',
    '  <button id="btn-element" title="Select an element — click one, or drag a box around several">',
    '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '      <path d="M3 3h6M3 3v6M21 3h-6M21 3v6M3 21h6M3 21v-6M21 21h-6M21 21v-6"/></svg>Element</button>',
    '  <button id="btn-text" title="Edit text — click a text node to rewrite it in place">',
    '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '      <path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>Text</button>',
    '  <div class="sep"></div>',
    '  <button id="btn-reload" title="Reload this page">',
    '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg></button>',
    '</div>',
  ].join('\n');

  var ui = {};
  [
    'layer', 'outline', 'tag', 'marquee', 'hint', 'bar', 'grip', 'dot', 'state',
    'btn-element', 'btn-text', 'btn-reload',
    'offline', 'offline-title', 'offline-body', 'offline-dismiss',
  ].forEach(function (id) {
    ui[id] = shadow.getElementById(id);
  });

  var mount = function () {
    (document.body || document.documentElement).appendChild(host);
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  /* ------------------------------------------------------- toolbar plumbing */

  var HINTS = {
    element: 'Click an element, or drag a box around several. Esc to exit.',
    text: 'Click any text to edit it. Enter or ✅ to save, Esc or ❌ to discard.',
  };
  var hintTimer = null;

  function showHint(text, ms) {
    if (!text) {
      ui.hint.classList.remove('show');
      return;
    }
    ui.hint.textContent = text;
    ui.hint.classList.add('show');
    clearTimeout(hintTimer);
    if (ms) hintTimer = setTimeout(function () { ui.hint.classList.remove('show'); }, ms);
  }

  function setMode(mode, quiet) {
    if (state.edit) endEdit(false);
    if (state.request) closeRequest();
    state.mode = mode;
    ui['btn-element'].classList.toggle('active', mode === 'element');
    ui['btn-text'].classList.toggle('active', mode === 'text');
    clearVisuals();
    showHint(HINTS[mode] || '', mode === 'off' ? 1 : 0);
    document.documentElement.style.cursor = mode === 'off' ? '' : 'crosshair';
    // Element mode drags boxes, so the page must not try to select text too.
    document.documentElement.style.userSelect = mode === 'element' ? 'none' : '';
    document.documentElement.style.webkitUserSelect = mode === 'element' ? 'none' : '';
    if (mode !== 'text') clearNativeSelection();
    if (!quiet) send({ type: 'mode', mode: mode });
  }

  ui['btn-element'].addEventListener('click', function () {
    setMode(state.mode === 'element' ? 'off' : 'element');
  });
  ui['btn-text'].addEventListener('click', function () {
    setMode(state.mode === 'text' ? 'off' : 'text');
  });
  ui['btn-reload'].addEventListener('click', function () {
    location.reload();
  });

  // Draggable toolbar, remembered per origin so it stays out of the design's way.
  (function draggable() {
    var pos = null;
    try {
      pos = JSON.parse(localStorage.getItem('__web_designer_bar__') || 'null');
    } catch (e) {}
    if (pos) {
      ui.bar.style.left = pos.left + 'px';
      ui.bar.style.top = pos.top + 'px';
      ui.bar.style.bottom = 'auto';
    }
    var start = null;
    ui.grip.addEventListener('mousedown', function (e) {
      var r = ui.bar.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!start) return;
      var left = Math.max(4, Math.min(innerWidth - 60, start.left + e.clientX - start.x));
      var top = Math.max(4, Math.min(innerHeight - 40, start.top + e.clientY - start.y));
      ui.bar.style.left = left + 'px';
      ui.bar.style.top = top + 'px';
      ui.bar.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', function () {
      if (!start) return;
      start = null;
      var r = ui.bar.getBoundingClientRect();
      try {
        localStorage.setItem('__web_designer_bar__', JSON.stringify({ left: r.left, top: r.top }));
      } catch (e) {}
    });
  })();

  /* ------------------------------------------------------------ dom helpers */

  function isOurs(node) {
    return !!(node && (node === host || (node.closest && node.closest('[data-web-designer]'))));
  }

  function elementAtPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (isOurs(el)) return null;
    return el && el !== document.documentElement ? el : null;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    var esc = window.CSS && CSS.escape ? CSS.escape.bind(CSS) : function (s) { return s; };
    var unique = function (sel) {
      try {
        return document.querySelectorAll(sel).length === 1;
      } catch (e) {
        return false;
      }
    };
    if (el.id && unique('#' + esc(el.id))) return '#' + esc(el.id);

    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && unique('#' + esc(node.id))) {
        parts.unshift('#' + esc(node.id));
        return parts.join(' > ');
      }
      var part = node.localName;
      var parent = node.parentElement;
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (c) {
          return c.localName === node.localName;
        });
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    parts.unshift('html');
    return parts.join(' > ');
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var attrs = {};
    Array.prototype.forEach.call(el.attributes || [], function (a) {
      if (a.name !== 'contenteditable') attrs[a.name] = a.value;
    });
    var html = el.outerHTML || '';
    return {
      selector: cssPath(el),
      tag: el.localName,
      id: el.id || null,
      classes: el.classList ? Array.prototype.slice.call(el.classList) : [],
      attributes: attrs,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      html: html.length > 4000 ? html.slice(0, 4000) + '\n<!-- …truncated -->' : html,
      rect: {
        x: Math.round(rect.left + scrollX),
        y: Math.round(rect.top + scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function lowestCommonAncestor(elements) {
    if (!elements.length) return null;
    if (elements.length === 1) return elements[0];
    var chain = function (el) {
      var out = [];
      for (var n = el; n; n = n.parentElement) out.unshift(n);
      return out;
    };
    var base = chain(elements[0]);
    for (var i = 1; i < elements.length; i++) {
      var other = chain(elements[i]);
      var j = 0;
      while (j < base.length && j < other.length && base[j] === other[j]) j++;
      base = base.slice(0, j);
      if (!base.length) return document.body;
    }
    return base[base.length - 1] || document.body;
  }

  /* -------------------------------------------------------------- visuals */

  function place(node, rect, extra) {
    node.style.display = 'block';
    node.style.left = rect.left + 'px';
    node.style.top = rect.top + 'px';
    if (extra !== 'tag') {
      node.style.width = rect.width + 'px';
      node.style.height = rect.height + 'px';
    }
  }

  function showOutline(el, solid) {
    var r = el.getBoundingClientRect();
    ui.outline.classList.toggle('solid', !!solid);
    ui.tag.classList.toggle('solid', !!solid);
    place(ui.outline, r);
    ui.tag.textContent =
      el.localName +
      (el.id ? '#' + el.id : '') +
      (el.classList && el.classList.length ? '.' + Array.prototype.slice.call(el.classList).slice(0, 2).join('.') : '') +
      '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    ui.tag.style.display = 'block';
    var top = r.top - 22 < 4 ? r.top + 4 : r.top - 22;
    ui.tag.style.left = Math.max(4, r.left) + 'px';
    ui.tag.style.top = top + 'px';
  }

  var textBoxes = [];
  function clearTextBoxes() {
    textBoxes.forEach(function (b) { b.remove(); });
    textBoxes = [];
  }

  function showTextNode(node) {
    clearTextBoxes();
    var range = document.createRange();
    range.selectNodeContents(node);
    Array.prototype.forEach.call(range.getClientRects(), function (r) {
      if (!r.width || !r.height) return;
      var box = document.createElement('div');
      box.className = 'textbox';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      ui.layer.appendChild(box);
      textBoxes.push(box);
    });
  }

  function clearVisuals() {
    ui.outline.style.display = 'none';
    ui.tag.style.display = 'none';
    ui.marquee.style.display = 'none';
    clearTextBoxes();
    state.hover = null;
    state.drag = null;
  }

  /* ------------------------------------------------------- element selector */

  function onMouseMove(e) {
    if (state.mode === 'off' || state.edit) return;

    if (state.drag) {
      var d = state.drag;
      d.moved = d.moved || Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > MARQUEE_THRESHOLD;
      if (d.moved) {
        ui.outline.style.display = 'none';
        ui.tag.style.display = 'none';
        place(ui.marquee, {
          left: Math.min(d.x, e.clientX),
          top: Math.min(d.y, e.clientY),
          width: Math.abs(e.clientX - d.x),
          height: Math.abs(e.clientY - d.y),
        });
      }
      return;
    }

    if (state.mode === 'element') {
      var el = elementAtPoint(e.clientX, e.clientY);
      if (!el) return clearVisuals();
      state.hover = el;
      showOutline(el);
    } else if (state.mode === 'text') {
      var node = textNodeAtPoint(e.clientX, e.clientY);
      state.hover = node;
      if (node) showTextNode(node);
      else clearTextBoxes();
    }
  }

  function onMouseDown(e) {
    if (state.mode !== 'element' || state.edit || isOurs(e.target)) return;
    // Suppress the browser's own text selection while drawing a marquee.
    e.preventDefault();
    clearNativeSelection();
    state.drag = { x: e.clientX, y: e.clientY, moved: false };
  }

  function clearNativeSelection() {
    try {
      var sel = window.getSelection();
      if (sel && sel.rangeCount) sel.removeAllRanges();
    } catch (e) {}
  }

  function onMouseUp(e) {
    if (state.mode !== 'element' || state.edit || isOurs(e.target)) return;
    var drag = state.drag;
    state.drag = null;
    ui.marquee.style.display = 'none';
    if (!drag) return;

    var el;
    if (drag.moved) {
      var box = {
        left: Math.min(drag.x, e.clientX),
        top: Math.min(drag.y, e.clientY),
        right: Math.max(drag.x, e.clientX),
        bottom: Math.max(drag.y, e.clientY),
      };
      el = elementForBox(box);
      if (!el) return showHint('Nothing inside that box — try again.', 2000);
      select(el, { via: 'marquee', box: box });
    } else {
      el = elementAtPoint(e.clientX, e.clientY);
      if (!el) return;
      select(el, { via: 'click' });
    }
  }

  // Everything fully inside the marquee, then their closest common ancestor.
  function elementForBox(box) {
    var inside = [];
    var touching = [];
    var all = document.body ? document.body.querySelectorAll('*') : [];
    Array.prototype.forEach.call(all, function (el) {
      if (isOurs(el)) return;
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (r.left >= box.left && r.top >= box.top && r.right <= box.right && r.bottom <= box.bottom) inside.push(el);
      else if (r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom) touching.push(el);
    });
    var pool = inside.length ? inside : touching;
    if (!pool.length) return null;
    // Drop elements that are descendants of another in the pool: the ancestor speaks for them.
    var tops = pool.filter(function (el) {
      return !pool.some(function (other) { return other !== el && other.contains(el); });
    });
    return lowestCommonAncestor(tops);
  }

  /*
   * Selecting ends element mode: the pick stays marked in green and a request
   * box opens on it, because a selection on its own is not yet an instruction.
   */
  function select(el, meta) {
    var info = describe(el);
    send({ type: 'element.selected', payload: Object.assign({}, info, meta || {}) });
    setMode('off');
    showOutline(el, true);
    startElementRequest(el, info);
  }

  var requestBox = null;

  function startElementRequest(el, info) {
    state.request = { el: el, info: info };

    requestBox = document.createElement('div');
    requestBox.className = 'request';
    requestBox.innerHTML =
      '<div class="sel"></div>' +
      '<div class="row"><textarea rows="1" placeholder="Describe the change…"></textarea>' +
      '<div class="actions"><button class="no" title="Cancel — deselect and send nothing">❌</button>' +
      '<button class="yes" title="Send this request to the assistant">✅</button></div></div>' +
      '<div class="keys">Enter to send · Shift+Enter for a new line · Esc to cancel</div>';
    requestBox.querySelector('.sel').textContent = info.selector;

    var textarea = requestBox.querySelector('textarea');
    textarea.addEventListener('input', function () {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
      positionRequest();
    });
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitRequest();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeRequest('Cancelled.');
      }
      e.stopPropagation();
    });
    requestBox.querySelector('.no').addEventListener('mousedown', function (e) {
      e.preventDefault();
      closeRequest('Cancelled.');
    });
    requestBox.querySelector('.yes').addEventListener('mousedown', function (e) {
      e.preventDefault();
      submitRequest();
    });

    shadow.appendChild(requestBox);
    positionRequest();
    textarea.focus();
    showHint('', 1);
  }

  function positionRequest() {
    if (!requestBox || !state.request) return;
    var r = state.request.el.getBoundingClientRect();
    var box = requestBox.getBoundingClientRect();
    var top = r.bottom + 10;
    if (top + box.height > innerHeight - 8) top = Math.max(8, r.top - box.height - 10);
    requestBox.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, r.left)) + 'px';
    requestBox.style.top = top + 'px';
  }

  function submitRequest() {
    if (!state.request) return;
    var textarea = requestBox && requestBox.querySelector('textarea');
    var text = textarea ? textarea.value.trim() : '';
    if (!text) {
      if (textarea) textarea.focus();
      return showHint('Type what you want changed first.', 2000);
    }
    send({ type: 'element.request', payload: Object.assign({}, state.request.info, { request: text }) });
    closeRequest('Sent — the assistant is on it.');
  }

  function closeRequest(hint) {
    if (requestBox) requestBox.remove();
    requestBox = null;
    state.request = null;
    clearVisuals();
    if (hint) showHint(hint, 2500);
  }

  /* ---------------------------------------------------------- text selector */

  function textNodeAtPoint(x, y) {
    var el = elementAtPoint(x, y);
    if (!el) return null;

    var node = null;
    if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(x, y);
      if (pos) node = pos.offsetNode;
    } else if (document.caretRangeFromPoint) {
      var range = document.caretRangeFromPoint(x, y);
      if (range) node = range.startContainer;
    }
    if (node && node.nodeType === 3 && node.nodeValue.trim() && !isOurs(node.parentElement)) return node;

    for (var i = 0; i < el.childNodes.length; i++) {
      var child = el.childNodes[i];
      if (child.nodeType === 3 && child.nodeValue.trim()) return child;
    }
    return null;
  }

  function startEdit(node) {
    var el = node.parentElement;
    if (!el || isOurs(el)) return;

    clearTextBoxes();
    state.edit = {
      el: el,
      oldHtml: el.innerHTML,
      oldText: el.textContent,
      selector: cssPath(el),
      prevEditable: el.getAttribute('contenteditable'),
    };

    el.setAttribute('contenteditable', 'true');
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    showConfirm(el);
    showHint('Editing — Enter or ✅ keeps it, Esc or ❌ restores it.', 0);
  }

  var confirmBox = null;
  function showConfirm(el) {
    hideConfirm();
    confirmBox = document.createElement('div');
    confirmBox.className = 'confirm';
    confirmBox.innerHTML =
      '<button class="no" title="Discard — restore the original text">❌</button>' +
      '<button class="yes" title="Keep — send the change to the designer">✅</button>';
    confirmBox.querySelector('.no').addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      endEdit(false);
    });
    confirmBox.querySelector('.yes').addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      endEdit(true);
    });
    shadow.appendChild(confirmBox);
    positionConfirm(el);
  }

  function positionConfirm(el) {
    if (!confirmBox) return;
    var r = el.getBoundingClientRect();
    var top = r.top - 44 < 4 ? r.bottom + 8 : r.top - 44;
    confirmBox.style.left = Math.max(4, Math.min(innerWidth - 110, r.left)) + 'px';
    confirmBox.style.top = Math.max(4, top) + 'px';
  }

  function hideConfirm() {
    if (confirmBox) confirmBox.remove();
    confirmBox = null;
  }

  function endEdit(keep) {
    var edit = state.edit;
    if (!edit) return;
    state.edit = null;

    var newText = edit.el.textContent;
    if (keep) {
      // Normalise back to a plain text node: contenteditable can leave markup behind.
      if (edit.el.childNodes.length !== 1 || edit.el.firstChild.nodeType !== 3) {
        var stillPlain = !/[<>]/.test(edit.oldHtml.trim());
        if (stillPlain) edit.el.textContent = newText;
      }
    } else {
      edit.el.innerHTML = edit.oldHtml;
    }

    if (edit.prevEditable === null) edit.el.removeAttribute('contenteditable');
    else edit.el.setAttribute('contenteditable', edit.prevEditable);

    try {
      window.getSelection().removeAllRanges();
    } catch (e) {}
    hideConfirm();
    clearVisuals();

    var payload = { selector: edit.selector, tag: edit.el.localName, oldText: edit.oldText, newText: newText };
    if (keep) {
      send({ type: 'text.edited', payload: payload });
      showHint(edit.oldText === newText ? 'No change made.' : 'Saved — sent to the designer.', 2500);
    } else {
      send({ type: 'text.cancelled', payload: payload });
      showHint('Reverted.', 1500);
    }
  }

  /* ---------------------------------------------------------- input capture */

  function onClickCapture(e) {
    if (state.mode === 'off' || isOurs(e.target)) return;
    if (state.edit) {
      // Clicks inside the element being edited are normal caret moves.
      if (state.edit.el.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      endEdit(false);
      return;
    }
    // Suppress the design's own click handling (links, buttons) while selecting.
    e.preventDefault();
    e.stopPropagation();
    if (state.mode === 'text') {
      var node = textNodeAtPoint(e.clientX, e.clientY);
      if (node) startEdit(node);
    }
  }

  function onKeyDown(e) {
    if (state.edit) {
      if (e.key === 'Escape') {
        e.preventDefault();
        endEdit(false);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        endEdit(true);
      }
      return;
    }
    if (state.request) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRequest('Cancelled.');
      }
      return;
    }
    if (e.key === 'Escape' && state.mode !== 'off') {
      e.preventDefault();
      setMode('off');
    }
  }

  function onScrollOrResize() {
    if (state.request) {
      showOutline(state.request.el, true);
      return positionRequest();
    }
    if (state.edit) return positionConfirm(state.edit.el);
    if (state.mode === 'element' && state.hover && state.hover.nodeType === 1) showOutline(state.hover);
    else if (state.mode === 'text' && state.hover) showTextNode(state.hover);
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);

  /* -------------------------------------------------------- refresh timing */

  /*
   * A reload in the middle of a gesture is infuriating: it eats a half-drawn
   * marquee, a half-typed request, or the text the user just selected. So a
   * refresh from the server waits for the user to be still — no button down,
   * no selection, no open panel, and at least IDLE_MS since they last moved.
   * If they are already idle when it arrives, it happens immediately.
   */
  var IDLE_MS = 1000;
  var refresh = { pending: false, timer: null, last: 0, pointer: false };

  function noteActivity() {
    refresh.last = Date.now();
  }

  function userBusy() {
    if (refresh.pointer || state.drag || state.edit || state.request) return true;
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && String(sel)) return true;
    return false;
  }

  function requestRefresh() {
    refresh.pending = true;
    tickRefresh();
  }

  function tickRefresh() {
    clearTimeout(refresh.timer);
    refresh.timer = null;
    if (!refresh.pending) return;
    var idle = Date.now() - refresh.last;
    if (!userBusy() && idle >= IDLE_MS) {
      refresh.pending = false;
      location.reload();
      return;
    }
    refresh.timer = setTimeout(tickRefresh, userBusy() ? 200 : Math.max(50, IDLE_MS - idle));
  }

  ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart', 'touchmove'].forEach(function (evt) {
    window.addEventListener(evt, noteActivity, { capture: true, passive: true });
  });
  window.addEventListener('mousedown', function () { refresh.pointer = true; }, true);
  ['mouseup', 'blur'].forEach(function (evt) {
    window.addEventListener(evt, function () {
      refresh.pointer = false;
      noteActivity();
    }, true);
  });
  document.addEventListener('selectionchange', noteActivity, true);

  /* ------------------------------------------------------------ screenshots */

  /*
   * Rendered by the page itself — no headless browser involved.
   *   1. HTML-in-Canvas: ctx.drawElement(el, x, y)  (Chrome, needs the
   *      "HTML in Canvas" / CanvasDrawElement feature enabled)
   *   2. ctx.drawElementImage(el, x, y) where that spelling is shipped
   *   3. SVG <foreignObject>, only with --allow-svg-fallback: approximate,
   *      external CSS and cross-origin images may be missing.
   */
  function canvasCapability() {
    var proto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
    if (!proto) return null;
    if (typeof proto.drawElement === 'function') return 'drawElement';
    if (typeof proto.drawElementImage === 'function') return 'drawElementImage';
    return null;
  }

  async function screenshot(opts) {
    var el = opts.selector ? document.querySelector(opts.selector) : document.body;
    if (!el) return { ok: false, error: 'no element matches selector: ' + opts.selector };

    var full = opts.full || !opts.selector;
    var scale = Math.max(0.1, Math.min(4, opts.scale || 1));
    var pad = opts.padding || 0;
    var rect = full
      ? {
          width: Math.max(document.documentElement.scrollWidth, innerWidth),
          height: Math.max(document.documentElement.scrollHeight, innerHeight),
        }
      : (function () {
          var r = el.getBoundingClientRect();
          return { width: r.width + pad * 2, height: r.height + pad * 2 };
        })();

    if (rect.width < 1 || rect.height < 1) return { ok: false, error: 'element has no visible box' };

    var method = canvasCapability();
    if (!method && !opts.allowSvgFallback) {
      return {
        ok: false,
        error:
          'this browser has no HTML-in-Canvas support (ctx.drawElementImage / ctx.drawElement). ' +
          'Turn on chrome://flags/#canvas-draw-element and restart Chrome (or launch it with ' +
          '--enable-blink-features=CanvasDrawElement), use the claude-in-chrome screenshot tool, ' +
          'or re-run with --allow-svg-fallback for an approximate capture.',
        capability: null,
      };
    }
    if (method && document.visibilityState !== 'visible') {
      return {
        ok: false,
        error:
          'this tab is in the background — HTML-in-Canvas can only capture a painted page. ' +
          'Bring the tab to the front and retry.',
        capability: method,
      };
    }

    host.style.display = 'none'; // keep the toolbar out of the shot
    try {
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(rect.width * scale);
      canvas.height = Math.round(rect.height * scale);
      var ctx = canvas.getContext('2d');
      if (scale !== 1) ctx.scale(scale, scale);

      // Whatever shows through the element's transparent parts is the page
      // behind it, so start from that colour rather than from transparency.
      ctx.save();
      ctx.fillStyle = backdropColor(full ? document.body || el : el);
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.restore();

      if (method) await drawViaCanvasSubtree(canvas, ctx, method, el, rect, pad, full);
      else {
        await drawViaForeignObject(ctx, el, rect);
        method = 'foreignObject';
      }

      var dataUrl = canvas.toDataURL('image/png');
      return {
        ok: true,
        method: method,
        dataUrl: dataUrl,
        width: canvas.width,
        height: canvas.height,
        selector: opts.selector || null,
        url: location.href,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), capability: method };
    } finally {
      host.style.display = '';
    }
  }

  /*
   * HTML-in-Canvas, as Chrome actually ships it:
   *   - the canvas needs the `layoutsubtree` attribute;
   *   - only an *immediate child* of that canvas can be drawn, so the target is
   *     cloned in beside itself (same parent ⇒ inherited styles and ancestor
   *     selectors still apply to the clone);
   *   - the clone only gets a paint record if it is actually painted, so the
   *     canvas sits in the viewport at ~zero opacity rather than off-screen.
   */
  async function drawViaCanvasSubtree(canvas, ctx, method, el, rect, pad, full) {
    canvas.setAttribute('layoutsubtree', '');
    canvas.style.cssText =
      'position:fixed;left:0;top:0;margin:0;padding:0;border:0;opacity:0.01;pointer-events:none;' +
      'contain:strict;z-index:2147483000;width:' + rect.width + 'px;height:' + rect.height + 'px';

    var clone = el.cloneNode(true);
    if (clone.querySelectorAll) {
      Array.prototype.forEach.call(clone.querySelectorAll('[data-web-designer]'), function (n) {
        n.remove();
      });
    }
    clone.style.width = rect.width - pad * 2 + 'px';
    if (full) clone.style.margin = '0';

    canvas.appendChild(clone);
    (el.parentElement || document.documentElement).appendChild(canvas);

    try {
      await painted();
      ctx[method](clone, pad, pad);
    } finally {
      canvas.remove();
    }
  }

  // Two frames is what it takes for a freshly inserted subtree to have a paint
  // record; the timeout keeps a throttled tab from hanging the capture forever.
  function painted() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(function () {
        requestAnimationFrame(finish);
      });
      setTimeout(finish, 1000);
    });
  }

  // Pull in every same-origin stylesheet, not just inline <style> blocks.
  function collectCss() {
    var out = [];
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      try {
        Array.prototype.forEach.call(sheet.cssRules, function (rule) {
          out.push(rule.cssText);
        });
      } catch (e) {
        /* cross-origin sheet: unreadable, skip it */
      }
    });
    return out.join('\n');
  }

  // Custom properties and inherited text styles live on :root / body, which the
  // detached clone is no longer under — carry them onto the wrapper by hand.
  function inheritedStyle(el) {
    var decls = [];
    [document.documentElement, document.body, el].forEach(function (src) {
      if (!src) return;
      var cs = getComputedStyle(src);
      for (var i = 0; i < cs.length; i++) {
        var prop = cs[i];
        if (prop.indexOf('--') === 0) decls.push(prop + ':' + cs.getPropertyValue(prop));
      }
    });
    var cs = getComputedStyle(el);
    ['color', 'font', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align'].forEach(
      function (prop) {
        var v = cs.getPropertyValue(prop);
        if (v) decls.push(prop + ':' + v);
      },
    );
    return decls.join(';');
  }

  function backdropColor(el) {
    for (var n = el; n; n = n.parentElement) {
      var bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) return bg;
    }
    return getComputedStyle(document.body || document.documentElement).backgroundColor || '#fff';
  }

  function drawViaForeignObject(ctx, el, rect) {
    var clone = el.cloneNode(true);
    clone.querySelectorAll && Array.prototype.forEach.call(clone.querySelectorAll('[data-web-designer]'), function (n) {
      n.remove();
    });
    var wrapper = document.createElement('div');
    wrapper.appendChild(clone);

    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + rect.width + '" height="' + rect.height + '">' +
      '<foreignObject width="100%" height="100%">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="' + inheritedStyle(el).replace(/"/g, "'") + '">' +
      '<style>' + collectCss() + '</style>' + wrapper.innerHTML + '</div>' +
      '</foreignObject></svg>';
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        ctx.drawImage(img, 0, 0);
        resolve();
      };
      img.onerror = function () { reject(new Error('foreignObject rasterisation failed')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  /* -------------------------------------------------------------- transport */

  function send(msg) {
    if (state.ws && state.ws.readyState === 1) {
      try {
        state.ws.send(JSON.stringify(msg));
      } catch (e) {}
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws;
    try {
      ws = new WebSocket(proto + '//' + location.host + '/__designer/ws');
    } catch (e) {
      return schedule();
    }
    state.ws = ws;

    ws.onopen = function () {
      state.connected = true;
      state.retry = 0;
      // The server says whether anyone is listening; until it does, assume not.
      renderStatus({ listening: false, working: false });
      send({
        type: 'hello',
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      });
    };

    ws.onclose = function () {
      state.connected = false;
      renderStatus(null);
      schedule();
    };
    ws.onerror = function () {
      try {
        ws.close();
      } catch (e) {}
    };

    ws.onmessage = async function (e) {
      var msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      switch (msg.type) {
        case 'refresh':
          requestRefresh();
          break;
        case 'mode':
          setMode(msg.mode === 'element' || msg.mode === 'text' ? msg.mode : 'off', true);
          break;
        case 'highlight': {
          var el = msg.selector && document.querySelector(msg.selector);
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            showOutline(el, true);
            setTimeout(clearVisuals, msg.duration || 2500);
          }
          send({ id: msg.id, type: 'result', ok: !!el, error: el ? undefined : 'no match: ' + msg.selector });
          break;
        }
        case 'exec': {
          try {
            /* eslint-disable no-new-func */
            var fn = new Function('return (async () => {' + msg.code + '})()');
            var value = await fn();
            send({ id: msg.id, type: 'result', ok: true, value: safeValue(value) });
          } catch (err) {
            send({ id: msg.id, type: 'result', ok: false, error: String((err && err.stack) || err) });
          }
          break;
        }
        case 'screenshot': {
          var shot = await screenshot(msg);
          send(Object.assign({ id: msg.id, type: 'result' }, shot));
          break;
        }
        case 'status':
          renderStatus(msg);
          break;
        case 'server-stopping':
          renderStatus(null);
          break;
      }
    };
  }

  /*
   * red = no socket · yellow = server up but nobody polling ·
   * green = an agent is listening · spinner = an agent is working on your ask.
   */
  function renderStatus(status) {
    var dot = ui.dot;
    dot.classList.remove('idle', 'listening', 'working');
    ui.state.classList.remove('busy');
    updateOffline(status);

    if (!status || !state.connected) {
      ui.state.textContent = 'offline';
      ui.grip.title = 'not connected to the design server';
      return;
    }
    if (status.working) {
      dot.classList.add('working');
      ui.state.classList.add('busy');
      ui.state.textContent = 'working\u2026';
      ui.grip.title = status.note ? 'working on: ' + status.note : 'the assistant is working on your request';
      return;
    }
    if (status.listening) {
      dot.classList.add('listening');
      ui.state.textContent = 'listening';
      ui.grip.title = 'an assistant is listening — pick an element or edit text';
      return;
    }
    dot.classList.add('idle');
    ui.state.textContent = 'idle';
    ui.grip.title = 'server up, but no assistant is listening right now';
  }

  /*
   * Offline notice. Red (no socket) and yellow (nobody polling) both mean the
   * user's clicks go nowhere, so both get the same blurb — the only fix is to
   * ask the assistant to come back. Shown after a short grace period so the
   * normal edit → refresh → re-poll gap never flashes it up.
   */
  var OFFLINE_GRACE_MS = 3000;
  var offline = { timer: null, shown: false, dismissed: false, status: null };

  ui['offline-dismiss'].addEventListener('click', function () {
    offline.dismissed = true;
    hideOffline();
  });

  function hideOffline() {
    clearTimeout(offline.timer);
    offline.timer = null;
    offline.shown = false;
    ui.offline.classList.remove('show');
  }

  function updateOffline(status) {
    offline.status = status;
    var live = !!(state.connected && status && (status.listening || status.working));
    if (live) {
      offline.dismissed = false;
      return hideOffline();
    }
    if (offline.shown) return writeOfflineText();
    if (offline.dismissed || offline.timer) return;
    offline.timer = setTimeout(function () {
      offline.timer = null;
      offline.shown = true;
      writeOfflineText();
      ui.offline.classList.add('show');
    }, OFFLINE_GRACE_MS);
  }

  function writeOfflineText() {
    var down = !state.connected || !offline.status;
    ui['offline-title'].textContent = down
      ? 'The assistant is disconnected'
      : 'The assistant has stopped listening';
    ui['offline-body'].textContent = down
      ? 'This page has lost its connection to the design server, so nothing you do here reaches the assistant.'
      : 'It is no longer watching this page, so anything you click or type here goes nowhere.';
  }

  function safeValue(value) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return String(value);
    }
  }

  function schedule() {
    state.retry = Math.min(state.retry + 1, 10);
    setTimeout(connect, Math.min(500 * state.retry, 5000));
  }

  window.addEventListener('pagehide', function () {
    send({ type: 'unload', url: location.href });
  });
  window.addEventListener('beforeunload', function () {
    send({ type: 'unload', url: location.href });
  });
  ['popstate', 'hashchange'].forEach(function (evt) {
    window.addEventListener(evt, function () {
      send({ type: 'navigate', url: location.href, title: document.title });
    });
  });
  window.addEventListener('error', function (e) {
    send({ type: 'error', message: String((e && e.message) || 'error') });
  });

  connect();

  window.__WEB_DESIGNER__ = {
    version: 1,
    setMode: setMode,
    screenshot: screenshot,
    state: state,
    describe: describe,
    cssPath: cssPath,
  };
})();
