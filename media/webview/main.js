// VSGrok chat webview. No inline handlers; all markdown sanitized with DOMPurify.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages'), input = $('input'), sendBtn = $('send'), chipsEl = $('chips');
  const pill = $('new-output'), announce = $('sr-announce');
  const state = { streaming: null, hasEditor: false, editorPath: undefined, chips: [], chipsExpanded: false, images: [] };
  const turns = new Map(); // id -> {el, body, raw, timer, state}

  marked.setOptions({ gfm: true, breaks: false });
  const renderer = new marked.Renderer();
  renderer.code = function (tok) {
    const info = (tok.lang || '').trim();
    const lang = info.split(/\s+/)[0] || 'text';
    const pm = info.match(/path=(\S+)/);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return '<pre data-lang="' + esc(lang) + '"' + (pm ? ' data-path="' + esc(pm[1]) + '"' : '') + '><code>' + esc(tok.text) + '</code></pre>';
  };
  marked.use({ renderer });

  function md(raw, streaming) {
    let src = raw;
    const fences = (src.match(/^\s*```/gm) || []).length;
    const open = fences % 2 === 1;
    if (streaming && open) { src += '\n```'; }
    const html = DOMPurify.sanitize(marked.parse(src), { ADD_ATTR: ['data-lang', 'data-path'] });
    return { html, open: streaming && open };
  }

  // ── scrolling ──
  function nearBottom() { return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40; }
  function stick(wasNear) { if (wasNear) { messagesEl.scrollTop = messagesEl.scrollHeight; pill.hidden = true; } else { pill.hidden = false; } }
  messagesEl.addEventListener('scroll', () => { if (nearBottom()) { pill.hidden = true; } });
  pill.addEventListener('click', () => { messagesEl.scrollTop = messagesEl.scrollHeight; pill.hidden = true; });
  // Links in answers: http(s) open externally; workspace paths like src/a.ts#L12 open the file at that line.
  messagesEl.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a || ev.defaultPrevented) { return; }
    const href = a.getAttribute('href') || '';
    ev.preventDefault();
    if (/^https?:\/\//i.test(href)) { vscode.postMessage({ type: 'openLink', url: href }); }
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) { vscode.postMessage({ type: 'openFileLink', href }); }
  });

  // ── code blocks ──
  function decorateBlocks(container, lastOpen) {
    const pres = container.querySelectorAll('pre');
    pres.forEach((pre, i) => {
      const isOpen = lastOpen && i === pres.length - 1;
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      const lang = pre.dataset.lang || 'text';
      let path = pre.dataset.path;
      if (!path) { const m = text.split('\n')[0].match(/^\s*(?:\/\/|#|--|\/\*)\s*([\w./-]+\.\w+)\s*(?:\*\/)?\s*$/); if (m) { path = m[1]; } }
      const head = document.createElement('div');
      head.className = 'code-head';
      const label = document.createElement('span');
      label.className = 'code-lang';
      label.textContent = lang + (path ? ' · ' + path : '');
      head.appendChild(label);
      const actions = document.createElement('span');
      actions.className = 'code-actions';
      const mk = (txt, title, fn, disabled) => {
        const b = document.createElement('button');
        b.className = 'code-btn'; b.textContent = txt; b.title = title; b.disabled = !!disabled || isOpen;
        b.addEventListener('click', () => fn(b)); actions.appendChild(b); return b;
      };
      mk('Copy', 'Copy code', (b) => { navigator.clipboard.writeText(text).then(() => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); }); });
      mk('Insert', state.hasEditor ? 'Insert at cursor (replaces selection)' : 'No active editor', () => vscode.postMessage({ type: 'insertCode', code: text, lang }), !state.hasEditor);
      if (path || state.hasEditor) {
        const blockId = 'b' + Math.random().toString(36).slice(2);
        pre.dataset.blockId = blockId;
        mk('Apply as diff', 'Review as diff against ' + (path || state.editorPath || 'active editor'), (b) => {
          b.disabled = true; b.classList.add('pending'); b.textContent = 'Reviewing…';
          vscode.postMessage({ type: 'applyDiff', code: text, lang, targetPath: path, blockId });
        });
      }
      head.appendChild(actions);
      pre.parentNode.insertBefore(head, pre);
      const wrap = document.createElement('div'); wrap.className = 'code-block';
      head.parentNode.insertBefore(wrap, head); wrap.appendChild(head); wrap.appendChild(pre);
    });
  }

  // Turns are sequential segments in arrival order: text, tool steps / cards, text, … New items never go above earlier text.
  function closeText(t) {
    if (!t.body) { return; }
    if (t.timer) { cancelAnimationFrame(t.timer); t.timer = null; }
    if (t.segRaw) { const st = t.state; t.state = 'segment'; renderTurn(t); t.state = st; } else { t.body.remove(); }
    t.body = null; t.segRaw = '';
  }
  /** Container for a non-text item (tool step or card) at the end of the turn. */
  function itemSlot(t) {
    closeText(t);
    const last = t.el.lastElementChild;
    if (last && last.classList.contains('tool-events')) { t.tools = last; return last; }
    const tools = document.createElement('div'); tools.className = 'tool-events'; t.el.appendChild(tools); t.tools = tools;
    return tools;
  }
  /** Append a card at the end of the conversation: inside the streaming turn (as its newest segment) or after it. */
  function appendLive(card) { const t = state.streaming ? turns.get(state.streaming) : null; (t && t.state === 'streaming' ? itemSlot(t) : messagesEl).appendChild(card); return card; }
  function textSlot(t) {
    if (!t.body) { const b = document.createElement('div'); b.className = 'body'; t.el.appendChild(b); t.body = b; t.segRaw = ''; }
    return t.body;
  }
  /** A card that needs the user's action: always bring it into view (focus is set by the caller). */
  function revealCard(card) { if (typeof card.scrollIntoView === 'function') { card.scrollIntoView({ block: 'nearest' }); } if (nearBottom()) { pill.hidden = true; } }
  function renderTurn(t) {
    if (!t.body) { return; }
    const wasNear = nearBottom();
    const r = md(t.segRaw, t.state === 'streaming');
    t.body.innerHTML = r.html;
    t.body.querySelectorAll('a[href]').forEach((a) => { if (!a.title) { a.title = a.getAttribute('href'); } });
    decorateBlocks(t.body, r.open);
    if (t.state === 'streaming') { const last = t.body.lastElementChild; if (last) { last.classList.add('caret'); } else { t.body.classList.add('caret'); } }
    stick(wasNear);
  }
  function scheduleRender(t) {
    if (t.timer) { return; }
    t.timer = requestAnimationFrame(() => { t.timer = null; renderTurn(t); });
  }

  function chipEl(c, removable) {
    const el = document.createElement(removable ? 'button' : 'span');
    el.className = 'chip' + (c.implicit ? ' implicit' : '');
    el.title = c.path + (c.implicit ? ' (current selection — click to pin)' : '');
    const icon = c.kind === 'folder' ? '📁' : c.kind === 'selection' ? '✂' : '📄';
    const lab = document.createElement('span'); lab.className = 'chip-label'; lab.textContent = icon + ' ' + c.label;
    el.appendChild(lab);
    if (removable) {
      el.addEventListener('click', () => vscode.postMessage({ type: c.implicit ? 'pinContext' : 'openContext', id: c.id }));
      if (!c.implicit) {
        const x = document.createElement('span'); x.className = 'chip-x'; x.textContent = '×'; x.setAttribute('role', 'button'); x.tabIndex = 0;
        x.setAttribute('aria-label', 'Remove ' + c.label);
        const rm = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'removeContext', id: c.id }); };
        x.addEventListener('click', rm); x.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { rm(e); } });
        el.appendChild(x);
      }
    }
    return el;
  }
  function renderImageTray() {
    const tray = $('image-tray'); tray.innerHTML = '';
    const imgs = state.images || [];
    tray.hidden = !imgs.length;
    imgs.forEach((im, i) => {
      const b = document.createElement('div'); b.className = 'chip image-chip'; b.setAttribute('role', 'listitem');
      const alt = 'Image ' + (i + 1) + ': ' + im.name;
      const tb = document.createElement('button'); tb.type = 'button'; tb.className = 'thumb'; tb.setAttribute('aria-label', 'Preview ' + alt); tb.title = im.name;
      const th = document.createElement('img'); th.src = im.dataUrl; th.alt = ''; th.width = 28; th.height = 28; tb.appendChild(th);
      tb.addEventListener('click', () => openPreview(im.dataUrl, alt, tb));
      const x = document.createElement('button'); x.type = 'button'; x.className = 'chip-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove image ' + (i + 1) + ' (' + im.name + ')');
      x.addEventListener('click', () => {
        state.images = state.images.filter((o) => o.id !== im.id); renderImageTray(); input.focus();
        announce.textContent = 'Removed image ' + (i + 1) + '. ' + state.images.length + ' left.';
      });
      b.append(tb, x); tray.appendChild(b);
    });
  }
  // In-webview image preview (<dialog>): Esc or Close, focus returns to the opener.
  let previewOpener = null;
  function openPreview(src, alt, opener) {
    const dlg = $('img-preview'); const img = $('img-preview-img');
    img.src = src; img.alt = alt; previewOpener = opener || null;
    if (typeof dlg.showModal === 'function') { dlg.showModal(); } else { dlg.setAttribute('open', ''); }
    $('img-preview-close').focus();
  }
  function closePreview() {
    const dlg = $('img-preview');
    if (typeof dlg.close === 'function' && dlg.open) { dlg.close(); } else { dlg.removeAttribute('open'); }
    if (previewOpener) { previewOpener.focus(); previewOpener = null; }
  }
  $('img-preview-close').addEventListener('click', closePreview);
  $('img-preview').addEventListener('cancel', (e) => { e.preventDefault(); closePreview(); });
  $('img-preview').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePreview(); } });
  function renderChips() {
    chipsEl.innerHTML = '';
    const list = state.chips;
    const pv = VSGrokCards.problemsChip(state.problems ? state.problems.count : 0, state.problems ? state.problems.enabled : true);
    chipsEl.hidden = list.length === 0 && pv.hidden;
    renderImageTray();
    if (!pv.hidden) {
      const pc = document.createElement('button'); pc.type = 'button'; pc.className = 'chip problems-chip' + (state.problems.enabled ? '' : ' off');
      const gl = document.createElement('span'); gl.className = 'chip-glyph'; gl.textContent = pv.glyph; gl.setAttribute('aria-hidden', 'true');
      pc.append(gl, document.createTextNode(' ' + pv.text)); pc.title = pv.tooltip; pc.setAttribute('aria-label', pv.ariaLabel); pc.setAttribute('aria-pressed', String(state.problems.enabled));
      pc.addEventListener('click', () => vscode.postMessage({ type: 'toggleProblems' }));
      chipsEl.appendChild(pc);
    }
    const shown = state.chipsExpanded ? list : list.slice(0, 4);
    shown.forEach((c) => chipsEl.appendChild(chipEl(c, true)));
    if (list.length > 4) {
      const more = document.createElement('button'); more.className = 'chip more';
      more.textContent = state.chipsExpanded ? 'Show less' : '+' + (list.length - 4) + ' more';
      more.addEventListener('click', () => { state.chipsExpanded = !state.chipsExpanded; renderChips(); });
      chipsEl.appendChild(more);
    }
  }

  function addUser(text, chips, images, names, sent) {
    const el = document.createElement('div'); el.className = 'message user';
    const t = document.createElement('div'); t.className = 'user-text'; t.textContent = text; el.appendChild(t);
    if (images && images.length) {
      const row = document.createElement('div'); row.className = 'user-images';
      images.forEach((u, i) => {
        if (!/^data:image\/(png|jpeg);base64,/.test(u)) { return; }
        const alt = 'Attached image ' + (i + 1) + (names && names[i] ? ': ' + names[i] : '');
        const b = document.createElement('button'); b.type = 'button'; b.className = 'thumb'; b.setAttribute('aria-label', 'Enlarge ' + alt);
        const im = document.createElement('img'); im.src = u; im.alt = ''; b.appendChild(im);
        b.addEventListener('click', () => openPreview(u, alt, b));
        row.appendChild(b);
      });
      el.appendChild(row);
    }
    if (chips && chips.length) { const row = document.createElement('div'); row.className = 'mini-chips'; chips.forEach((c) => row.appendChild(chipEl(c, false))); el.appendChild(row); }
    if (sent && sent.label) {
      // What was attached for Grok but not shown in the bubble (git diff, terminal output).
      const d = document.createElement('details'); d.className = 'sent-data';
      const s = document.createElement('summary'); s.textContent = String(sent.label); d.appendChild(s);
      const pre = document.createElement('pre'); pre.textContent = (sent.items || []).map(String).join('\n'); pre.tabIndex = 0; d.appendChild(pre);
      el.appendChild(d);
    }
    messagesEl.appendChild(el); messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function startTurn(id) {
    const el = document.createElement('div'); el.className = 'message assistant'; el.dataset.state = 'streaming';
    const who = document.createElement('div'); who.className = 'who';
    if (iconSrc) { const av = document.createElement('img'); av.className = 'avatar'; av.src = iconSrc; av.alt = ''; who.appendChild(av); }
    const nm = document.createElement('span'); nm.textContent = 'Grok'; who.appendChild(nm); el.appendChild(who);
    const body = document.createElement('div'); body.className = 'body';
    body.innerHTML = '<span class="typing" aria-label="Grok is typing"><i></i><i></i><i></i></span>';
    el.appendChild(body); messagesEl.appendChild(el);
    const t = { id, el, body, tools: null, raw: '', segRaw: '', timer: null, state: 'streaming' };
    turns.set(id, t); state.streaming = id; setSendMode(true);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return t;
  }

  function addChecksButton(foot) {
    if (!foot || foot.querySelector('.checks-btn')) { return; }
    const b = btn('🧪 Re-run checks', () => { b.disabled = true; b.textContent = '🧪 Asked Grok to re-run the checks'; vscode.postMessage({ type: 'rerunChecks' }); });
    b.classList.add('checks-btn'); b.title = 'Check Problems and run the tests on the files Grok changed?';
    foot.appendChild(b);
  }
  function lastAssistantFooter() { const all = messagesEl.querySelectorAll('.message.assistant .msg-footer'); return all.length ? all[all.length - 1] : null; }
  function finishTurn(t, st, extra) {
    if (!t || t.state !== 'streaming') { return; }
    t.state = st; t.el.dataset.state = st;
    if (t.timer) { cancelAnimationFrame(t.timer); t.timer = null; }
    if (t.body && t.segRaw) { renderTurn(t); } else if (t.body) { t.body.remove(); t.body = null; }
    const foot = document.createElement('div'); foot.className = 'msg-footer';
    if (st === 'stopped') { const s = document.createElement('span'); s.className = 'stopped-tag'; s.textContent = 'Stopped'; foot.appendChild(s); }
    if (st === 'error') {
      t.el.appendChild(errorCard(extra, true));
    } else {
      foot.appendChild(btn('Copy message', (b) => { navigator.clipboard.writeText(t.raw); vscode.postMessage({ type: 'copyMessage' }); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy message'), 1500); }));
      const rg = btn('Regenerate', () => vscode.postMessage({ type: 'regenerate' })); rg.classList.add('regen-btn'); foot.appendChild(rg);
      if (t.offerChecks) { addChecksButton(foot); }
      if (extra && extra.meta) {
        const m = extra.meta; const parts = [];
        if (m.model) { parts.push(m.model); }
        if (m.completionTokens) { parts.push(m.completionTokens + ' tok'); }
        if (m.reasoningTokens) { parts.push(m.reasoningTokens + ' reasoning'); }
        if (m.cachedTokens) { parts.push(m.cachedTokens + ' cached'); }
        if (m.inputTokens) { parts.push(Math.round(m.inputTokens / 1000) + 'k ctx'); }
        if (m.costUsd) { parts.push('$' + (m.costUsd < 0.01 ? m.costUsd.toFixed(4) : m.costUsd.toFixed(3))); }
        if (m.latencyMs) { parts.push((m.latencyMs / 1000).toFixed(1) + 's'); }
        const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = parts.join(' · '); foot.appendChild(meta);
      }
    }
    if (extra && Array.isArray(extra.citations) && extra.citations.length) {
      const box = document.createElement('div'); box.className = 'citations';
      const h = document.createElement('div'); h.className = 'citations-title'; h.textContent = 'Sources'; box.appendChild(h);
      const ol = document.createElement('ol');
      extra.citations.forEach((c) => {
        if (!c || typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) { return; }
        const li = document.createElement('li'); const a = document.createElement('a');
        a.href = c.url; a.title = c.url;
        a.addEventListener('click', (ev) => { ev.preventDefault(); vscode.postMessage({ type: 'openLink', url: c.url }); });
        let label = c.url; try { const u = new URL(c.url); label = u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : ''); } catch (e) { /* keep url */ }
        a.textContent = label.length > 80 ? label.slice(0, 79) + '…' : label;
        li.appendChild(a); ol.appendChild(li);
      });
      box.appendChild(ol); t.el.appendChild(box);
    }
    t.el.appendChild(foot);
    if (state.streaming === t.id) { state.streaming = null; setSendMode(false); }
    announce.textContent = st === 'done' ? 'Grok finished responding.' : st === 'stopped' ? 'Stopped.' : 'Error: ' + VSGrokCards.errorSpec(extra || {}, true).title;
  }
  function btn(txt, fn) { const b = document.createElement('button'); b.className = 'foot-btn'; b.textContent = txt; b.addEventListener('click', () => fn(b)); return b; }

  function setSendMode(streaming) {
    sendBtn.classList.toggle('stop', streaming);
    sendBtn.textContent = streaming ? '■' : '➤';
    sendBtn.setAttribute('aria-label', streaming ? 'Stop generating' : state.taskMode ? 'Start task' : 'Send');
    sendBtn.title = streaming ? '' : state.taskMode ? 'Start task' : '';
  }
  function stop() {
    if (!state.streaming) { return; }
    vscode.postMessage({ type: 'stop' });
    finishTurn(turns.get(state.streaming), 'stopped');
  }
  function send() {
    if (state.streaming) { return; }
    const text = input.value.trim();
    const imgs = state.images.map((i) => i.dataUrl);
    if (!text && !imgs.length) { return; }
    if (state.taskMode && !imgs.length) {
      vscode.postMessage({ type: 'runTask', text });
      input.value = ''; autoGrow(); setTaskMode(false);
      return;
    }
    const q = imgs.length ? { type: 'query', text: text || VSGrokCards.imagesOnlyPrompt(imgs.length), images: imgs, imageNames: state.images.map((i) => i.name) } : { type: 'query', text };
    // Kept until the extension echoes userMessage; restored if a vision note refuses the send.
    state.pending = { text: input.value, query: q };
    vscode.postMessage(q);
    input.value = ''; autoGrow();
  }
  // ---- image input: paste, drop, Attach image; downscaled here, sent as PNG/JPEG data URLs ----

  let imgSeq = 0, pasteSeq = 0, imgInFlight = 0;
  function loadImage(src) { return new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => fail(new Error('not a readable image')); im.src = src; }); }
  function readFile(f) { return new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => fail(r.error); r.readAsDataURL(f); }); }
  async function normalizeImage(dataUrl) {
    const mime = (/^data:([\w/+.-]+);/.exec(dataUrl) || [])[1] || '';
    const im = await loadImage(dataUrl);
    const w = im.naturalWidth, h = im.naturalHeight;
    if (VSGrokCards.keepOriginal(mime, VSGrokCards.dataUrlBytes(dataUrl), w, h)) { return dataUrl; }
    const sz = VSGrokCards.fitSize(w, h);
    const c = document.createElement('canvas'); c.width = sz.w; c.height = sz.h;
    const g = c.getContext('2d'); if (!g) { throw new Error('canvas unavailable'); }
    if (mime !== 'image/png') { g.fillStyle = '#fff'; g.fillRect(0, 0, sz.w, sz.h); }
    g.drawImage(im, 0, 0, sz.w, sz.h);
    if (mime === 'image/png') { const p = c.toDataURL('image/png'); if (VSGrokCards.dataUrlBytes(p) <= VSGrokCards.IMG.BYTES) { return p; } g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, sz.w, sz.h); }
    for (const q of [0.85, 0.7, 0.55, 0.4]) { const j = c.toDataURL('image/jpeg', q); if (VSGrokCards.dataUrlBytes(j) <= VSGrokCards.IMG.BYTES) { return j; } }
    throw new Error('image too large even after compression');
  }
  async function addImages(sources) {
    // Reserve slots synchronously so concurrent drops/pastes can't exceed the cap.
    const room = VSGrokCards.imageRoom(state.images.length + imgInFlight, sources.length);
    imgInFlight += room.take;
    if (room.dropped) { toast(VSGrokCards.IMG.MAX + ' images max per message. ' + room.dropped + (room.dropped === 1 ? ' wasn\'t' : ' weren\'t') + ' added.'); }
    for (const src of sources.slice(0, room.take)) {
      try {
        const raw = typeof src.dataUrl === 'string' ? src.dataUrl : await readFile(src.file);
        const dataUrl = await normalizeImage(raw);
        ++imgSeq; state.images.push({ id: 'img' + imgSeq, dataUrl, name: src.name || (src.pasted ? 'Pasted image ' + (++pasteSeq) : 'image ' + imgSeq) });
      } catch (err) { toast('Couldn\'t attach ' + (src.name || 'image') + ': ' + (err && err.message ? err.message : err)); }
      finally { imgInFlight--; }
    }
    renderImageTray();
  }
  // Toasts stack in #toasts; each stays 6s + 1s per 40 chars, pauses on hover/focus, closes on click or Esc.
  function toast(msg) {
    const box = $('toasts');
    const d = document.createElement('div'); d.className = 'toast'; d.setAttribute('role', 'status'); d.tabIndex = 0; d.textContent = String(msg);
    let left = VSGrokCards.toastMs(d.textContent), started = Date.now(), timer = null;
    const close = () => { clearTimeout(timer); d.remove(); };
    const run = () => { started = Date.now(); timer = setTimeout(close, left); };
    const pause = () => { clearTimeout(timer); left = Math.max(1000, left - (Date.now() - started)); };
    d.addEventListener('mouseenter', pause); d.addEventListener('focus', pause);
    d.addEventListener('mouseleave', run); d.addEventListener('blur', run);
    d.addEventListener('click', close); d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); } });
    box.appendChild(d); run();
    return d;
  }
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const files = items.filter((it) => it.kind === 'file' && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) { return; }
    e.preventDefault();
    void addImages(files.map((f) => ({ file: f, name: f.name && !/^image\.\w+$/.test(f.name) ? f.name : '' , pasted: true })));
  });
  // ---- background task mode ----
  const taskBtn = $('task-toggle');
  function setTaskMode(on) {
    state.taskMode = !!on; taskBtn.setAttribute('aria-pressed', String(state.taskMode));
    if (!state.streaming) { sendBtn.setAttribute('aria-label', state.taskMode ? 'Start task' : 'Send'); sendBtn.title = state.taskMode ? 'Start task' : ''; }
    input.placeholder = state.taskMode ? 'Describe the task for Grok to run on its own… (Enter to start)' : input.dataset.ph || input.placeholder;
  }
  input.dataset.ph = input.placeholder;
  taskBtn.addEventListener('click', () => { setTaskMode(!state.taskMode); input.focus(); });
  const taskCards = new Map();
  const mcpBtn = $('mcp-btn');
  mcpBtn.addEventListener('click', () => vscode.postMessage({ type: 'mcpServers' }));
  $('mcp-settings-link').addEventListener('click', () => vscode.postMessage({ type: 'mcpServers' }));
  function renderMcp(m) {
    const errors = m.errors | 0, pending = m.pending | 0;
    mcpBtn.hidden = !errors && !pending;
    mcpBtn.textContent = pending ? '🛡 MCP' : '⚠ MCP';
    mcpBtn.setAttribute('aria-label', pending ? pending + ' MCP server(s) from this repo wait for your consent. Review' : errors + ' MCP server(s) failed. Show MCP servers');
    mcpBtn.title = mcpBtn.getAttribute('aria-label');
  }
  const taskPill = $('task-pill');
  function renderTaskPill() {
    const t = state.task;
    taskPill.hidden = !t;
    if (t) { taskPill.textContent = '▶ Task · ' + t.steps + '/' + t.maxSteps; taskPill.setAttribute('aria-label', 'Running task: ' + t.goal + '. Step ' + t.steps + ' of ' + t.maxSteps + '. Show the task card'); }
  }
  taskPill.addEventListener('click', () => { const c = state.task && taskCards.get(state.task.id); if (c) { c.scrollIntoView({ block: 'nearest' }); const b = c.querySelector('button'); if (b) { b.focus({ preventScroll: true }); } } });
  function taskCard(m) {
    const wasNear = nearBottom();
    const card = document.createElement('div'); card.className = 'approval-card task-card'; card.dataset.state = 'running';
    card.setAttribute('role', 'group'); card.setAttribute('aria-label', 'Background task');
    const head = document.createElement('div'); head.className = 'approval-head'; head.textContent = '▶ Task running'; card.appendChild(head);
    const goal = document.createElement('div'); goal.className = 'task-goal'; goal.textContent = VSGrokCards.firstLine(m.goal, 160); card.appendChild(goal);
    const lvl = document.createElement('div'); lvl.className = 'approval-meta'; lvl.textContent = VSGrokCards.levelLabel(m.level) + '. Deletes, renames, other commands and files outside the workspace always ask.'; card.appendChild(lvl);
    const prog = document.createElement('div'); prog.className = 'task-progress'; // not live: announced via #sr-announce, throttled
    prog.textContent = VSGrokCards.taskProgressText({ steps: 0, maxSteps: m.maxSteps, tokens: 0 }); card.appendChild(prog);
    const cur = document.createElement('div'); cur.className = 'task-current'; card.appendChild(cur);
    const log = document.createElement('ul'); log.className = 'task-log'; log.setAttribute('aria-label', 'Approvals in this task'); card.appendChild(log);
    const files = document.createElement('ul'); files.className = 'plan-files'; files.hidden = true; card.appendChild(files);
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const stopB = document.createElement('button'); stopB.className = 'approval-btn deny'; stopB.textContent = 'Stop task'; stopB.dataset.action = 'stop';
    const status = document.createElement('div'); status.className = 'approval-status'; status.setAttribute('aria-live', 'polite');
    stopB.addEventListener('click', () => { stopB.disabled = true; holdFocus(card, status, 'Stopping…'); stop(); });
    actions.appendChild(stopB); card.appendChild(actions);
    card.appendChild(status);
    messagesEl.appendChild(card); stick(wasNear);
    taskCards.set(String(m.id), card);
    state.task = { id: String(m.id), goal: VSGrokCards.firstLine(m.goal, 60), steps: 0, maxSteps: m.maxSteps | 0, lastAnnounce: Date.now() };
    renderTaskPill();
    announce.textContent = 'Task started';
  }
  function taskEnd(m) {
    const card = taskCards.get(String(m.id)); if (!card) { return; }
    card.dataset.state = m.outcome === 'done' ? 'approved' : m.outcome === 'error' ? 'denied' : 'stopped';
    const files = (m.files || []).map(String);
    card.querySelector('.approval-head').textContent = VSGrokCards.taskEndHead(String(m.outcome), files.length);
    card.querySelector('.task-current').textContent = '';
    card.querySelector('.task-progress').textContent = VSGrokCards.taskProgressText(m) + ' · ' + Math.round((m.ms || 0) / 1000) + ' s';
    const ul = card.querySelector('.plan-files'); ul.innerHTML = '';
    for (const f of files.slice(0, 100)) { const li = document.createElement('li'); li.textContent = f; ul.appendChild(li); }
    ul.hidden = !files.length;
    const actions = card.querySelector('.approval-actions'); actions.innerHTML = '';
    if (files.length) {
      const label = 'Undo all (' + files.length + ')';
      const u = document.createElement('button'); u.className = 'approval-btn deny'; u.textContent = label; u.dataset.action = 'undo-all';
      u.addEventListener('click', () => {
        // Destructive across N files: second click confirms (same pattern as history Delete).
        if (!u.dataset.confirm) {
          u.dataset.confirm = '1'; u.textContent = 'Confirm undo (' + files.length + ')'; announce.textContent = 'Press again to undo ' + files.length + ' files';
          setTimeout(() => { if (u.isConnected && !u.disabled) { delete u.dataset.confirm; u.textContent = label; } }, 4000);
          return;
        }
        u.disabled = true; card.querySelector('.approval-status').textContent = 'Undoing…'; vscode.postMessage({ type: 'undoTask', id: String(m.id) });
      });
      actions.appendChild(u);
    }
    if (state.task && state.task.id === String(m.id)) { state.task = null; renderTaskPill(); }
    releaseFocus(card);
    announce.textContent = card.querySelector('.approval-head').textContent;
  }
  $('attach-image').addEventListener('click', () => vscode.postMessage({ type: 'pickImage' }));
  function toggleCostPop(open) {
    const pop = $('cost-pop'), btnEl = $('cost-meter');
    const o = open === undefined ? pop.hidden : open;
    pop.hidden = !o; btnEl.setAttribute('aria-expanded', String(o));
    if (o) { pop.tabIndex = -1; pop.focus({ preventScroll: true }); }
  }
  $('cost-meter').addEventListener('click', () => toggleCostPop());
  $('cost-row-details').addEventListener('click', () => { toggleCostPop(true); });
  $('cost-pop').addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleCostPop(false); $('cost-meter').focus(); } });
  function autoGrow() {
    input.style.height = 'auto';
    const lh = parseFloat(getComputedStyle(input).lineHeight) || 18;
    input.style.height = Math.min(input.scrollHeight, lh * 8 + 12) + 'px';
  }

  sendBtn.addEventListener('click', () => (state.streaming ? stop() : send()));
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.streaming) { e.preventDefault(); stop(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.streaming && document.activeElement !== input) { stop(); } });
  $('rules-chip').addEventListener('click', () => vscode.postMessage({ type: 'openRules' }));
  $('add-ctx').addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }));
  $('clear-btn').addEventListener('click', () => vscode.postMessage({ type: 'clearChat' }));
  $('setkey-btn').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
  $('agent').addEventListener('change', (e) => vscode.postMessage({ type: 'setAgent', enabled: e.target.checked }));
  function setToggle(id, on, disabled) { const b = $(id); b.setAttribute('aria-pressed', String(!!on)); b.classList.toggle('on', !!on); b.disabled = !!disabled; }
  [['web-toggle', 'web'], ['x-toggle', 'x']].forEach(([id, tool]) => {
    $(id).addEventListener('click', (e) => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; setToggle(id, on); vscode.postMessage({ type: 'setServerTool', tool, enabled: on }); });
  });
  // ---- tabs + history ----
  const tabsEl = $('tabs');
  function renderTabs(tabs, active) {
    // Keep keyboard focus in the strip across re-renders (UIGrok H): refocus the active tab.
    const hadFocus = tabsEl.contains(document.activeElement);
    tabsEl.innerHTML = '';
    tabs.forEach((t) => {
      const wrap = document.createElement('div'); wrap.className = 'tab' + (t.id === active ? ' active' : '');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tab-btn'; b.setAttribute('role', 'tab');
      b.id = 'tab-' + t.id; b.setAttribute('aria-controls', 'messages-wrap');
      b.setAttribute('aria-selected', String(t.id === active)); b.tabIndex = t.id === active ? 0 : -1;
      b.textContent = VSGrokCards.firstLine(t.title, 28) || 'New chat'; b.title = t.title; b.dataset.id = t.id;
      b.setAttribute('aria-label', t.title || 'New chat');
      b.addEventListener('click', () => vscode.postMessage({ type: 'switchTab', id: t.id }));
      b.addEventListener('keydown', (e) => {
        const bs = [...tabsEl.querySelectorAll('.tab-btn')]; const i = bs.indexOf(b);
        let n = null;
        if (e.key === 'ArrowRight') { n = bs[(i + 1) % bs.length]; } else if (e.key === 'ArrowLeft') { n = bs[(i + bs.length - 1) % bs.length]; }
        else if (e.key === 'Home') { n = bs[0]; } else if (e.key === 'End') { n = bs[bs.length - 1]; }
        if (n) { e.preventDefault(); n.focus(); return; }
        if (e.key === 'Delete' && tabs.length > 1) { e.preventDefault(); vscode.postMessage({ type: 'closeTab', id: t.id }); }
      });
      const x = document.createElement('button'); x.type = 'button'; x.className = 'tab-close'; x.textContent = '×'; x.setAttribute('aria-label', 'Close ' + (t.title || 'chat') + ' (stays in history)');
      x.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'closeTab', id: t.id }); });
      wrap.appendChild(b); if (tabs.length > 1) { wrap.appendChild(x); } tabsEl.appendChild(wrap);
    });
    const add = document.createElement('button'); add.type = 'button'; add.className = 'tab-add'; add.textContent = '+'; add.setAttribute('aria-label', 'New chat tab');
    add.addEventListener('click', () => vscode.postMessage({ type: 'newTab' }));
    tabsEl.appendChild(add);
    const sel = tabsEl.querySelector('.tab-btn[aria-selected=true]');
    const wrapEl = $('messages-wrap');
    if (sel) { wrapEl.setAttribute('role', 'tabpanel'); wrapEl.setAttribute('aria-labelledby', sel.id); if (sel.scrollIntoView) { sel.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } }
    if (hadFocus && sel) { sel.focus({ preventScroll: true }); }
  }
  const hp = $('history-panel'); const hs = $('history-search'); const hl = $('history-list'); const hb = $('history-btn');
  let histTimer = null;
  function setHistory(open) {
    hp.hidden = !open; hb.setAttribute('aria-expanded', String(open));
    if (open) { vscode.postMessage({ type: 'historyList', query: hs.value }); hs.focus(); } else { hb.focus(); }
  }
  hb.addEventListener('click', () => setHistory(hp.hidden));
  hp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setHistory(false); } });
  hs.addEventListener('input', () => { clearTimeout(histTimer); histTimer = setTimeout(() => vscode.postMessage({ type: 'historyList', query: hs.value }), 150); });
  $('history-export').addEventListener('click', () => vscode.postMessage({ type: 'exportChat' }));
  function renderHistory(items, query) {
    hl.innerHTML = '';
    if (!items.length) { const li = document.createElement('li'); li.className = 'hist-empty'; li.textContent = query ? 'No chats match "' + query + '".' : 'No saved chats yet. Chats are saved on this computer after each answer.'; hl.appendChild(li); return; }
    for (const it of items) {
      const li = document.createElement('li'); li.className = 'hist-item'; li.dataset.id = it.id;
      const open = document.createElement('button'); open.type = 'button'; open.className = 'hist-open';
      const t = document.createElement('span'); t.className = 'hist-title'; t.textContent = it.title + (it.open ? ' (open)' : '');
      const meta = document.createElement('span'); meta.className = 'hist-meta'; meta.textContent = VSGrokCards.relTime(it.updated) + ' · ' + it.count + ' messages' + (it.preview ? ' · ' + it.preview : '');
      open.appendChild(t); open.appendChild(meta);
      open.setAttribute('aria-label', 'Open ' + it.title + ', ' + VSGrokCards.relTime(it.updated));
      open.addEventListener('click', () => { vscode.postMessage({ type: 'openChat', id: it.id }); setHistory(false); });
      const acts = document.createElement('span'); acts.className = 'hist-actions';
      const mk = (label, aria, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'h-btn link'; b.textContent = label; b.setAttribute('aria-label', aria + ' ' + it.title); b.addEventListener('click', fn); acts.appendChild(b); return b; };
      mk('Rename', 'Rename', () => vscode.postMessage({ type: 'renameChat', id: it.id }));
      mk('Export', 'Export to Markdown', () => vscode.postMessage({ type: 'exportChat', id: it.id }));
      const del = mk('Delete', 'Delete', () => {
        if (del.dataset.confirm) { vscode.postMessage({ type: 'deleteChat', id: it.id }); return; }
        del.dataset.confirm = '1'; del.textContent = 'Confirm delete'; del.classList.add('danger');
        announce.textContent = 'Press again to delete ' + it.title;
        setTimeout(() => { if (del.isConnected) { delete del.dataset.confirm; del.textContent = 'Delete'; del.classList.remove('danger'); } }, 4000);
      });
      li.appendChild(open); li.appendChild(acts); hl.appendChild(li);
    }
  }
  function renderTranscript(msgs) {
    taskCards.clear(); approvalCards.clear(); messagesEl.innerHTML = ''; turns.clear(); state.streaming = null; setSendMode(false);
    let n = 0;
    for (const m of msgs) {
      if (m.role === 'user') { addUser(String(m.text || ''), [], [], m.imageNames); continue; }
      const t = startTurn('h' + (++n) + '-' + Date.now().toString(36));
      t.raw = String(m.text || ''); t.segRaw = t.raw;
      finishTurn(t, m.state === 'stopped' ? 'stopped' : 'done', {});
    }
    if (msgs.length) { const n0 = document.createElement('div'); n0.className = 'transcript-note'; n0.setAttribute('role', 'note'); n0.textContent = 'Reopened chat · tool steps and cards aren’t shown'; messagesEl.insertBefore(n0, messagesEl.firstChild); }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    announce.textContent = msgs.length ? 'Chat opened: ' + msgs.length + ' messages' : 'New chat';
  }
  const sp = $('settings-panel');
  $('settings-btn').addEventListener('click', (e) => { const o = sp.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(o)); });
  const modelIn = $('model');
  let currentModel = '';
  function setModelOptions(models, current) {
    currentModel = current || currentModel;
    const ids = models.map((m) => m.id);
    if (currentModel && !ids.includes(currentModel)) { models = [{ id: currentModel }].concat(models); }
    modelIn.innerHTML = '';
    models.forEach((m) => {
      const o = document.createElement('option'); o.value = m.id; o.textContent = m.id;
      if (m.reasoning || m.contextLength) { o.title = [m.reasoning ? 'reasoning' : '', m.contextLength ? Math.round(m.contextLength / 1000) + 'k context' : ''].filter(Boolean).join(' · '); }
      modelIn.appendChild(o);
    });
    modelIn.value = currentModel;
  }
  modelIn.addEventListener('change', () => { currentModel = modelIn.value; vscode.postMessage({ type: 'updateSettings', model: modelIn.value }); });
  $('refresh-models-btn').addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
  $('get-key-btn').addEventListener('click', () => vscode.postMessage({ type: 'getApiKey' }));
  $('paste-key-btn').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
  const iconSrc = document.querySelector('.logo') ? document.querySelector('.logo').getAttribute('src') : '';
  ['temperature', 'maxTokens'].forEach((k) => {
    const el = $(k), v = $(k + '-val');
    el.addEventListener('input', () => (v.textContent = el.value));
    el.addEventListener('change', () => vscode.postMessage({ type: 'updateSettings', [k]: Number(el.value) }));
  });

  // drag & drop from Explorer
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].some((t) => t === 'Files' || /uri-list/.test(t));
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('drop-ok'); } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { document.body.classList.remove('drop-ok'); } });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('drop-ok');
    const dt = e.dataTransfer; if (!dt) { return; }
    const raw = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || dt.getData('text/plain');
    const uris = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[a-z][\w+.-]*:/i.test(s));
    if (uris.length) { vscode.postMessage({ type: 'dropFiles', uris }); return; }
    // Files dragged from the OS (no workspace path): only images are accepted, read here.
    const files = dt.files ? [...dt.files].filter((f) => /^image\//.test(f.type)) : [];
    if (files.length) { void addImages(files.map((f) => ({ file: f, name: f.name }))); }
  });


  // In-chat approval cards (commands, edits). Text only via textContent; decision goes back with reqId.
  const approvalCards = new Map();
  // Keyboard focus after a decision: hold it on the card's status line, then hand it back to the input.
  function holdFocus(card, status, text) {
    status.tabIndex = -1; status.textContent = text; status.focus({ preventScroll: true });
    card.dataset.heldFocus = '1';
  }
  function releaseFocus(card) {
    if (card.dataset.heldFocus !== '1') { return; }
    delete card.dataset.heldFocus;
    const a = document.activeElement;
    if (!a || a === document.body || card.contains(a)) { input.focus({ preventScroll: true }); }
  }
  /** Cards raised while a task runs are visibly tied to it. */
  function markInTask(card) {
    if (!state.task) { return; }
    card.classList.add('in-task'); card.dataset.task = state.task.id;
    const n = document.createElement('div'); n.className = 'approval-meta task-of'; n.textContent = 'Part of task: ' + state.task.goal; card.appendChild(n);
  }
  function pathNodes(el, p) {
    VSGrokCards.pathParts(p).forEach((seg, i, all) => { el.appendChild(document.createTextNode(seg)); if (i < all.length - 1) { el.appendChild(document.createElement('wbr')); } });
  }
  function addPlanCard(reqId, r) {
    const wasNear = nearBottom();
    const v = VSGrokCards.planSpec(r);
    const card = document.createElement('div'); card.className = 'approval-card plan-card'; card.dataset.kind = 'plan'; card.setAttribute('role', 'group'); card.setAttribute('aria-label', v.title);
    const head = document.createElement('div'); head.className = 'approval-head'; head.textContent = v.title; card.appendChild(head);
    if (v.meta) { const mt = document.createElement('div'); mt.className = 'plan-meta' + (v.hasDelete ? ' has-delete' : ''); mt.textContent = v.meta; card.appendChild(mt); }
    if (v.summary) { const sm = document.createElement('div'); sm.className = 'approval-meta'; sm.textContent = v.summary; card.appendChild(sm); }
    // Select all (tri-state)
    const allRow = document.createElement('div'); allRow.className = 'plan-all';
    const all = document.createElement('input'); all.type = 'checkbox'; all.id = reqId + '-all';
    const allLab = document.createElement('label'); allLab.htmlFor = all.id; allLab.textContent = 'Select all';
    allRow.append(all, allLab); card.appendChild(allRow);
    const list = document.createElement('ul'); list.className = 'plan-files';
    const boxes = []; // { cb, li, index } for usable rows only
    for (const f of v.files) {
      const li = document.createElement('li'); li.className = 'plan-file'; li.dataset.op = f.op;
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = reqId + '-f' + f.index;
      const lab = document.createElement('label'); lab.htmlFor = cb.id; lab.className = 'plan-path';
      const op = document.createElement('span'); op.className = 'plan-op'; op.textContent = f.icon; op.title = f.opLabel; op.setAttribute('aria-hidden', 'true');
      const sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = f.opLabel + ': ';
      const pt = document.createElement('span'); pt.className = 'plan-name'; pathNodes(pt, f.path);
      if (f.newPath) { const np = document.createElement('span'); np.className = 'plan-new'; np.appendChild(document.createTextNode('→ ')); pathNodes(np, f.newPath); pt.appendChild(np); }
      lab.append(op, sr, pt);
      li.append(cb, lab);
      if (f.refused) {
        cb.checked = false; cb.disabled = true; li.classList.add('refused');
        const rs = document.createElement('span'); rs.className = 'plan-reason'; rs.id = reqId + '-r' + f.index; rs.textContent = '⛔ ' + f.reason;
        cb.setAttribute('aria-describedby', rs.id); li.appendChild(rs);
      } else {
        cb.checked = true; boxes.push({ cb, li, index: f.index });
        if (f.warn) { const wn = document.createElement('span'); wn.className = 'plan-warn'; wn.id = reqId + '-w' + f.index; wn.textContent = '⚠ ' + f.warn; cb.setAttribute('aria-describedby', wn.id); li.appendChild(wn); }
        const dl = document.createElement('span'); dl.className = 'plan-delta'; dl.textContent = f.delta; dl.setAttribute('aria-label', f.deltaLabel);
        const vd = document.createElement('button'); vd.type = 'button'; vd.className = 'plan-diff'; vd.textContent = 'View diff'; vd.setAttribute('aria-label', 'View diff for ' + f.path);
        vd.addEventListener('click', () => vscode.postMessage({ type: 'approvalViewDiff', reqId, index: f.index }));
        li.append(dl, vd);
      }
      list.appendChild(li);
    }
    card.appendChild(list);
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const ok = document.createElement('button'); ok.className = 'approval-btn approve';
    const deny = document.createElement('button'); deny.className = 'approval-btn deny'; deny.textContent = 'Deny';
    const sync = () => {
      const n = boxes.filter(b => b.cb.checked).length;
      ok.textContent = VSGrokCards.approveLabel(n, boxes.length); ok.disabled = n === 0;
      const st = VSGrokCards.selectAllState(n, boxes.length); all.checked = st.checked; all.indeterminate = st.indeterminate;
    };
    boxes.forEach(b => b.cb.addEventListener('change', sync));
    all.addEventListener('change', () => { boxes.forEach(b => (b.cb.checked = all.checked)); sync(); });
    all.disabled = boxes.length === 0; sync();
    const status = document.createElement('div'); status.className = 'approval-status'; status.setAttribute('aria-live', 'polite');
    const decide = (decision) => {
      card.classList.add('pending');
      boxes.forEach(b => b.li.classList.toggle('skipped', decision === 'approve' && !b.cb.checked));
      card.querySelectorAll('button,input').forEach(b => (b.disabled = true));
      vscode.postMessage({ type: 'approvalResponse', reqId, decision, selected: boxes.filter(b => b.cb.checked).map(b => b.index) });
      holdFocus(card, status, decision === 'approve' ? 'Applying…' : 'Denying…');
    };
    ok.addEventListener('click', () => decide('approve')); deny.addEventListener('click', () => decide('deny'));
    actions.append(ok, deny); card.appendChild(actions);
    card.appendChild(status);
    const t = state.streaming ? turns.get(state.streaming) : null;
    (t ? itemSlot(t) : messagesEl).appendChild(card);
    approvalCards.set(reqId, card);
    // Don't focus Approve: a stray Enter would approve up to 50 changes. Start on Select all.
    stick(wasNear); revealCard(card); (all.disabled ? deny : all).focus({ preventScroll: true });
    announce.textContent = 'Approval needed: ' + v.title + (v.meta ? ', ' + v.meta : '');
  }
  function infoCard(cls, title, lines, buttons) {
    const wasNear = nearBottom();
    const card = document.createElement('div'); card.className = 'approval-card ' + cls; card.setAttribute('role', 'group'); card.setAttribute('aria-label', title);
    const head = document.createElement('div'); head.className = 'approval-head'; head.textContent = title; card.appendChild(head);
    if (lines && lines.length) { const ul = document.createElement('ul'); ul.className = 'plan-files'; for (const l of lines.slice(0, 50)) { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); } card.appendChild(ul); }
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    for (const b of buttons) { const x = document.createElement('button'); x.className = 'approval-btn ' + (b.primary ? 'approve' : 'deny'); x.textContent = b.label; if (b.action) { x.dataset.action = b.action; } x.addEventListener('click', () => b.fn(x, card)); actions.appendChild(x); }
    card.appendChild(actions);
    const status = document.createElement('div'); status.className = 'approval-status'; status.setAttribute('aria-live', 'polite'); card.appendChild(status);
    const t = state.streaming ? turns.get(state.streaming) : null;
    (t ? itemSlot(t) : messagesEl).appendChild(card); stick(wasNear);
    if (buttons && buttons.length) { revealCard(card); }
    return card;
  }
  const planCards = new Map();

  function addApprovalCard(reqId, r) {
    if (!r || approvalCards.has(reqId)) { return; }
    if (r.kind === 'plan') { addPlanCard(reqId, r); return; }
    const wasNear = nearBottom();
    const card = document.createElement('div'); card.className = 'approval-card'; card.dataset.kind = r.kind === 'command' || r.kind === 'mcp' ? r.kind : 'edit';
    card.setAttribute('role', 'group');
    markInTask(card);
    const head = document.createElement('div'); head.className = 'approval-head';
    head.textContent = r.kind === 'command' ? '⚡ Grok wants to run a command' : r.kind === 'mcp' ? '🔌 Grok wants to use an MCP tool' : (r.isNew ? '✦ Grok wants to create a file' : '✦ Grok wants to edit a file');
    card.setAttribute('aria-label', head.textContent);
    card.appendChild(head);
    if (r.kind === 'command') {
      const pre = document.createElement('pre'); pre.className = 'approval-cmd'; pre.textContent = String(r.command || ''); card.appendChild(pre);
      if (Array.isArray(r.runs) && r.runs.length) {
        const lab = document.createElement('div'); lab.className = 'approval-meta'; lab.textContent = 'This runs:'; card.appendChild(lab);
        const rp = document.createElement('pre'); rp.className = 'approval-cmd approval-runs'; rp.textContent = r.runs.map(String).join('\n'); card.appendChild(rp);
      }
      if (r.source) {
        const src = document.createElement('div'); src.className = 'approval-meta approval-source' + (r.repoControlled ? ' repo' : '');
        src.textContent = 'From ' + String(r.source) + (r.repoControlled ? ' · repo-controlled: check it before running' : ''); card.appendChild(src);
      }
    } else if (r.kind === 'mcp') {
      const p = document.createElement('div'); p.className = 'approval-path'; p.textContent = String(r.server || '') + ' › ' + String(r.tool || ''); card.appendChild(p);
      const src = document.createElement('div'); src.className = 'approval-meta approval-source' + (r.source === 'workspace' ? ' repo' : '');
      src.textContent = r.source === 'workspace' ? 'Server defined by this repo (you allowed it)' : 'Server from your user settings'; card.appendChild(src);
      const lab = document.createElement('div'); lab.className = 'approval-meta'; lab.textContent = 'Arguments:'; card.appendChild(lab);
      const pre = document.createElement('pre'); pre.className = 'approval-cmd'; pre.textContent = String(r.args || '{}'); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Arguments'); card.appendChild(pre);
    } else {
      const p = document.createElement('div'); p.className = 'approval-path'; p.textContent = String(r.path || ''); card.appendChild(p);
      const meta = document.createElement('div'); meta.className = 'approval-meta';
      const delta = (typeof r.added === 'number' ? '+' + r.added : '') + (typeof r.removed === 'number' ? ' −' + r.removed : '');
      meta.textContent = [r.reason ? String(r.reason) : '', delta.trim()].filter(Boolean).join(' · '); card.appendChild(meta);
      if (r.warn) { const w = document.createElement('div'); w.className = 'approval-meta approval-source repo approval-warn'; w.textContent = '⚠ ' + String(r.warn) + ' · check it before approving'; card.appendChild(w); }
    }
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'approval-btn ' + cls; b.textContent = label; b.addEventListener('click', fn); actions.appendChild(b); return b; };
    let always = null;
    // MCP "Always allow": its own row above the buttons (before Run in tab order), scope in visible text, never for repo servers.
    if (r.kind === 'mcp' && r.source !== 'workspace') {
      const row = document.createElement('label'); row.className = 'approval-always';
      always = document.createElement('input'); always.type = 'checkbox';
      row.appendChild(always); row.appendChild(document.createTextNode(' Always allow ' + String(r.tool || 'this tool') + ' from ' + String(r.server || 'this server') + ' (until its config changes)'));
      card.appendChild(row);
    }
    const decide = (decision) => {
      card.classList.add('pending'); actions.querySelectorAll('button,input').forEach(b => (b.disabled = true)); if (always) { always.disabled = true; }
      const al = !!(always && always.checked && decision === 'approve');
      const msg = { type: 'approvalResponse', reqId, decision }; if (al) { msg.always = true; }
      vscode.postMessage(msg);
      holdFocus(card, card.querySelector('.approval-status'), decision === 'approve' ? (r.kind === 'command' || r.kind === 'mcp' ? (al ? 'Running… · always allowed. Reset in VSGrok: MCP Servers' : 'Running…') : 'Applying…') : 'Denying…');
    };
    const runLabel = r.kind === 'command' || r.kind === 'mcp' ? 'Run' : 'Approve';
    const ok = mk(runLabel, 'approve', () => decide('approve'));
    mk('Deny', 'deny', () => decide('deny'));
    if (always) { always.addEventListener('change', () => { ok.textContent = always.checked ? 'Run & always allow' : runLabel; }); }
    if (r.kind === 'edit') { mk('View diff', 'diff', () => vscode.postMessage({ type: 'approvalViewDiff', reqId })); }
    card.appendChild(actions);
    const status = document.createElement('div'); status.className = 'approval-status'; status.setAttribute('aria-live', 'polite'); card.appendChild(status);
    const t = state.streaming ? turns.get(state.streaming) : null;
    (t ? itemSlot(t) : messagesEl).appendChild(card);
    approvalCards.set(reqId, card);
    stick(wasNear); revealCard(card);
    ok.focus({ preventScroll: true });
    announce.textContent = 'Approval needed: ' + head.textContent;
  }
  function resolveApprovalCard(reqId, st) {
    const card = approvalCards.get(reqId); if (!card) { return; }
    approvalCards.delete(reqId);
    card.classList.remove('pending'); card.dataset.state = st;
    const acts = card.querySelector('.approval-actions'); if (acts) { acts.remove(); }
    const stEl = card.querySelector('.approval-status');
    stEl.textContent = st === 'approved' ? '✓ Approved' : st === 'denied' ? '✕ Denied' : '⊘ ' + (st === 'panel reloaded' ? 'Cancelled (panel reloaded)' : st === 'panel closed' ? 'Cancelled (panel closed)' : 'Cancelled');
    releaseFocus(card);
  }

  // In-chat update card (GitHub releases). One card, refreshed in place.
  let updateCardEl = null;
  function renderUpdateCard(c) {
    if (!c) { return; }
    const wasNear = nearBottom();
    if (!updateCardEl || !updateCardEl.isConnected) { updateCardEl = document.createElement('div'); updateCardEl.className = 'approval-card update-card'; updateCardEl.dataset.kind = 'edit'; appendLive(updateCardEl); }
    const card = updateCardEl; card.textContent = ''; card.removeAttribute('data-state');
    const head = document.createElement('div'); head.className = 'approval-head'; card.appendChild(head);
    const meta = document.createElement('div'); meta.className = 'approval-meta'; card.appendChild(meta);
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const mk = (label, cls, action) => { const b = document.createElement('button'); b.className = 'approval-btn ' + cls; b.textContent = label; b.addEventListener('click', () => { if (action !== 'notes' && action !== 'dismiss') { actions.querySelectorAll('button').forEach(x => (x.disabled = true)); } if (action === 'dismiss') { card.remove(); return; } vscode.postMessage({ type: 'updateAction', action }); }); actions.appendChild(b); };
    const cur = String(c.current || ''), lat = String(c.latest || '');
    switch (c.state) {
      case 'available': head.textContent = '✦ VSGrok ' + lat + ' is available'; meta.textContent = 'You have ' + cur + '. Installs the release .vsix from GitHub.'; mk('Update now', 'approve', 'update'); mk("What's new", 'diff', 'notes'); mk('Later', 'deny', 'dismiss'); break;
      case 'downloading': head.textContent = '◌ Downloading VSGrok ' + lat + '…'; meta.textContent = 'Installing from GitHub Releases.'; break;
      case 'installed': head.textContent = '✓ VSGrok ' + lat + ' installed'; meta.textContent = 'Reload the window to start using it.'; card.dataset.state = 'approved'; mk('Reload Window', 'approve', 'reload'); mk('Later', 'deny', 'dismiss'); break;
      case 'uptodate': head.textContent = '✓ VSGrok is up to date'; meta.textContent = 'Installed ' + cur + (lat ? ' · latest release ' + lat : ' · no release found'); card.dataset.state = 'approved'; mk('Dismiss', 'deny', 'dismiss'); break;
      default: head.textContent = '✕ Update problem'; meta.textContent = String(c.msg || 'Unknown error'); card.dataset.state = 'denied'; if (c.url) { mk('Open release page', 'diff', 'notes'); } mk('Dismiss', 'deny', 'dismiss');
    }
    if (actions.childNodes.length) { card.appendChild(actions); }
    stick(wasNear);
  }

  // Friendly error cards (API errors from chat, commands and fixes). Text only; view model in cards.js.
  function errorCard(e, inTurn) {
    const v = VSGrokCards.errorSpec(e || {}, inTurn);
    const card = document.createElement('div'); card.className = 'error-card'; card.dataset.kind = v.kind; card.dataset.sev = v.sev;
    card.setAttribute('role', inTurn ? 'group' : 'alert'); // in-turn errors are announced once by finishTurn
    card.setAttribute('aria-label', v.title);
    const head = document.createElement('div'); head.className = 'error-head';
    const ic = document.createElement('span'); ic.className = 'error-icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = v.icon;
    const ti = document.createElement('span'); ti.className = 'error-title'; ti.textContent = v.title + (v.source ? ' · ' + v.source : '');
    head.append(ic, ti); card.appendChild(head);
    if (v.hint) { const h = document.createElement('div'); h.className = 'error-hint'; h.textContent = v.hint; card.appendChild(h); }
    if (v.details) {
      const det = document.createElement('details'); det.className = 'error-detail';
      const sm = document.createElement('summary'); sm.textContent = v.detailsLabel; det.appendChild(sm);
      const pre = document.createElement('pre'); pre.textContent = v.details; det.appendChild(pre); card.appendChild(det);
    }
    const acts = document.createElement('div'); acts.className = 'error-actions';
    const b = (label, primary, fn) => { const x = document.createElement('button'); x.className = 'error-btn' + (primary ? ' primary-action' : ''); x.textContent = label; x.addEventListener('click', fn); acts.appendChild(x); };
    for (const a of v.actions) { b(a.label, a.primary, () => vscode.postMessage(a.msg)); }
    if (v.dismissible) { b('Dismiss', false, () => card.remove()); }
    card.appendChild(acts);
    return card;
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    switch (m.type) {
      case 'settings':
        if (m.model) { currentModel = m.model; if (!Array.from(modelIn.options).some((o) => o.value === m.model)) { setModelOptions(Array.from(modelIn.options).map((o) => ({ id: o.value })), m.model); } modelIn.value = m.model; }
        if (m.theme) { document.body.classList.toggle('theme-galactic', m.theme !== 'vscode'); document.body.classList.toggle('theme-vscode', m.theme === 'vscode'); }
        if (m.temperature !== undefined) { $('temperature').value = m.temperature; $('temperature-val').textContent = m.temperature; }
        if (m.maxTokens !== undefined) { $('maxTokens').value = m.maxTokens; $('maxTokens-val').textContent = m.maxTokens; }
        $('agent').checked = !!m.agent;
        setToggle('web-toggle', m.webSearch, m.api === 'chat'); setToggle('x-toggle', m.xSearch, m.api === 'chat'); break;
      case 'models': setModelOptions(m.models || [], m.current); modelIn.title = 'Grok model' + (m.source === 'fallback' ? ' (built-in list: ' + (m.error || 'offline') + ')' : m.source === 'live' ? ' (live from xAI)' : ''); break;
      case 'keyState': $('welcome').hidden = !!m.hasKey; document.body.classList.toggle('no-key', !m.hasKey); break;
      case 'userMessage': addUser(m.text, m.chips, m.images, m.imageNames, m.sent); state.pending = null; if (m.images && m.images.length) { state.images = []; renderImageTray(); } break;
      case 'imageFile': if (typeof m.dataUrl === 'string') { void addImages([{ dataUrl: m.dataUrl, name: String(m.name || 'image') }]); } break;
      case 'imagesRefused': toast('Image not attached: ' + (m.reasons || []).map(String).join('; ')); break;
      case 'visionNote': {
        const v = VSGrokCards.visionNote(String(m.model), m.suggest ? String(m.suggest) : '');
        const pend = state.pending; state.pending = null;
        // Give the typed text back; the images are still attached.
        if (pend && !input.value.trim()) { input.value = pend.text; autoGrow(); }
        const btns = [];
        if (m.suggest) {
          btns.push({ label: v.action, action: 'switch', primary: true, fn: (b, c) => {
            c.querySelectorAll('button').forEach((x) => (x.disabled = true));
            currentModel = String(m.suggest); setModelOptions([...modelIn.options].map((o) => ({ id: o.value })), currentModel);
            const q = pend ? pend.query : null;
            if (q) {
              vscode.postMessage({ type: 'switchModelAndResend', model: currentModel, text: q.text, images: q.images, imageNames: q.imageNames });
              state.pending = { text: pend.text, query: q }; input.value = ''; autoGrow();
            } else { vscode.postMessage({ type: 'updateSettings', model: currentModel }); }
            c.querySelector('.approval-status').textContent = 'Switched to ' + currentModel + (q ? ' and resent.' : '.');
          } });
        }
        btns.push({ label: 'Send without images', action: 'text-only', primary: !m.suggest, fn: (b, c) => {
          c.querySelectorAll('button').forEach((x) => (x.disabled = true));
          state.images = []; renderImageTray();
          const text = (pend && pend.text.trim()) || input.value.trim();
          if (text) { state.pending = { text, query: { type: 'query', text } }; vscode.postMessage({ type: 'query', text }); input.value = ''; autoGrow(); }
          c.querySelector('.approval-status').textContent = text ? 'Sent without images.' : 'Images removed.';
        } });
        const card = infoCard('vision-note', v.title, [v.body], btns); card.dataset.kind = 'note';
        const primary = card.querySelector('.approval-btn.approve'); if (primary) { primary.focus({ preventScroll: true }); }
        announce.textContent = v.title + '. ' + v.body;
        break;
      }
      case 'demoBudget': {
        const spent = typeof m.spent === 'number' ? '$' + m.spent.toFixed(2) + ' so far, as reported by xAI' : 'xAI reported no cost, so a token estimate was used';
        const body = 'The demo paused at its $' + Number(m.limit).toFixed(2) + ' budget (' + spent + '). Continue with $' + Number(m.step).toFixed(2) + ' more, or stop here.';
        const done = (c, msg, type) => { c.querySelectorAll('button').forEach((x) => (x.disabled = true)); c.querySelector('.approval-status').textContent = msg; vscode.postMessage({ type }); };
        const card = infoCard('demo-budget', 'Demo budget reached', [body], [
          { label: 'Continue (+$' + Number(m.step).toFixed(2) + ')', action: 'continue', primary: true, fn: (b, c) => done(c, 'Continuing the demo.', 'demoContinue') },
          { label: 'Stop', action: 'stop', fn: (b, c) => done(c, 'Demo stopped.', 'demoStop') },
        ]);
        card.dataset.kind = 'note';
        const primary = card.querySelector('.approval-btn.approve'); if (primary) { primary.focus({ preventScroll: true }); }
        announce.textContent = 'Demo budget reached. ' + body;
        break;
      }
      case 'costMeter': {
        // Not a live region: the figures are read on demand (button + popover), never announced per turn.
        const el = $('cost-meter'); el.hidden = !!m.hidden; el.textContent = m.text || ''; el.title = m.tooltip || '';
        el.setAttribute('aria-label', m.hidden ? 'Chat usage' : String(m.ariaLabel || m.text));
        const lines = Array.isArray(m.lines) ? m.lines.map(String) : [];
        $('cost-detail').textContent = lines.join('. ');
        const pop = $('cost-pop'); pop.innerHTML = '';
        lines.forEach((l) => { const p = document.createElement('div'); p.textContent = l; pop.appendChild(p); });
        if (m.hidden) { pop.hidden = true; el.setAttribute('aria-expanded', 'false'); }
        $('cost-row').hidden = !!m.hidden; $('cost-row-val').textContent = m.text || '';
        break;
      }
      case 'streamStart': startTurn(m.id); break;
      case 'streamChunk': { const t = turns.get(m.id); if (t && t.state === 'streaming') { t.raw += m.delta; textSlot(t); t.segRaw += m.delta; scheduleRender(t); } break; }
      case 'toolEvent': {
        const t = turns.get(m.id); if (!t) { break; }
        const wn = nearBottom();
        let d = m.toolId ? t.el.querySelector('[data-tool-id="' + String(m.toolId).replace(/[^\w-]/g, '') + '"]') : null;
        if (!d) {
          d = document.createElement('details'); d.className = 'tool-event'; if (m.toolId) { d.dataset.toolId = String(m.toolId); }
          const sm = document.createElement('summary'); d.appendChild(sm); itemSlot(t).appendChild(d);
        }
        stick(wn);
        d.dataset.state = m.state || 'done';
        const sm = d.querySelector('summary');
        sm.textContent = (m.state === 'running' ? '◌ ' : m.state === 'error' ? '✕ ' : '✓ ') + String(m.label || m.text || '');
        if (typeof m.detail === 'string') {
          let pre = d.querySelector('pre'); if (!pre) { pre = document.createElement('pre'); d.appendChild(pre); }
          pre.textContent = m.detail;
        }
        break;
      }
      case 'streamDone': finishTurn(turns.get(m.id), 'done', { meta: m.meta, citations: m.citations }); break;
      case 'streamStopped': finishTurn(turns.get(m.id), 'stopped'); break;
      case 'streamError': finishTurn(turns.get(m.id), 'error', { msg: m.msg, kind: m.kind }); break;
      case 'editorState': state.hasEditor = !!m.hasEditor; state.editorPath = m.path;
        document.querySelectorAll('.code-block').forEach((w) => {
          const b = Array.from(w.querySelectorAll('.code-btn')).find((x) => x.textContent === 'Insert');
          const open = w.closest('.message') && w.closest('.message').dataset.state === 'streaming' && w === w.parentNode.lastElementChild;
          if (b && !open) { b.disabled = !state.hasEditor; b.title = state.hasEditor ? 'Insert at cursor (replaces selection)' : 'No active editor'; }
        }); break;
      case 'contextUpdate': state.chips = m.chips || []; renderChips(); break;
      case 'applyResult': {
        const pre = document.querySelector('pre[data-block-id="' + m.blockId + '"]');
        const wrap = pre && pre.parentNode;
        if (wrap) {
          const b = Array.from(wrap.querySelectorAll('.code-btn')).find((x) => x.classList.contains('pending'));
          if (b) { b.disabled = false; b.classList.remove('pending'); b.textContent = 'Apply as diff'; }
          const toast = document.createElement('div'); toast.className = 'block-toast ' + (m.ok ? 'ok' : 'bad'); toast.textContent = m.msg; wrap.appendChild(toast);
          setTimeout(() => toast.remove(), 5000);
        } break;
      }
      case 'approvalRequest': addApprovalCard(String(m.reqId), m.request); break;
      case 'approvalResolved': resolveApprovalCard(String(m.reqId), String(m.state || 'cancelled')); break;
      case 'updateCard': renderUpdateCard(m.card); break;
      case 'errorCard': { const wn = nearBottom(); if (m.card) { appendLive(errorCard(m.card, false)); } stick(wn); break; }
      case 'rules': {
        const rc = $('rules-chip'); const v = VSGrokCards.rulesChip(m.files, m.truncated);
        rc.hidden = v.hidden; rc.textContent = '';
        if (!v.hidden) {
          const ic = document.createElement('span'); ic.setAttribute('aria-hidden', 'true'); ic.textContent = '📜';
          const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = ' ' + v.label;
          const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = v.count;
          rc.append(ic, lbl, cnt);
        }
        rc.title = v.tooltip; rc.setAttribute('aria-label', v.tooltip || 'Project rules');
        break;
      }
      case 'contextRefused': {
        const box = $('chips'); const c = document.createElement('span'); c.className = 'chip refused'; c.setAttribute('role', 'status');
        c.textContent = '⛔ Refused ' + String(m.path || 'file') + (m.reason ? ': ' + String(m.reason) : '');
        box.appendChild(c); setTimeout(() => c.remove(), 6000); break;
      }
      case 'planApplied': {
        const pid = String(m.planId); const paths = (m.paths || []).map(String);
        const card = infoCard('plan-done', '✓ Plan applied' + (m.summary ? ' · ' + String(m.summary) : ''), paths, [
          { label: 'Undo plan', action: 'undo', primary: false, fn: (b, c) => { b.disabled = true; c.querySelector('.approval-status').textContent = 'Undoing…'; vscode.postMessage({ type: 'undoPlan', planId: pid }); } },
          { label: 'Re-run checks', action: 'checks', primary: true, fn: (b, c) => { b.disabled = true; vscode.postMessage({ type: 'rerunChecks' }); c.querySelector('.approval-status').textContent = 'Asked Grok to re-run the checks.'; } },
        ]);
        card.dataset.planId = pid; planCards.set(pid, card);
        announce.textContent = 'Plan applied: ' + paths.length + ' file' + (paths.length === 1 ? '' : 's');
        break;
      }
      case 'planUndone': {
        const card = planCards.get(String(m.planId)); if (!card) { break; }
        const undo = card.querySelector('[data-action="undo"]');
        card.querySelector('.approval-status').textContent = (m.ok ? '↶ ' : '✕ ') + String(m.msg || '');
        if (m.ok) {
          card.dataset.state = 'undone'; card.querySelector('.approval-head').textContent = '↶ Plan undone';
          if (undo) { undo.remove(); }
          announce.textContent = 'Plan undone';
        } else if (undo) { undo.disabled = !m.retryable; }
        break;
      }
      case 'checksOffer': {
        // A footer button on the assistant turn, not a card. Added when the turn finishes.
        const t = state.streaming ? turns.get(state.streaming) : null;
        if (t) { t.offerChecks = true; } else { addChecksButton(lastAssistantFooter()); }
        break;
      }
      case 'problemsState': { state.problems = { count: m.count | 0, enabled: !!m.enabled }; renderChips(); break; }
      case 'toast': toast(m.msg); break;
      case 'taskStart': taskCard(m); break;
      case 'mcpState': renderMcp(m); break;
      case 'openHistory': setHistory(true); break;
      case 'tabs': renderTabs(m.tabs || [], m.active); break;
      case 'historyItems': renderHistory(m.items || [], String(m.query || '')); break;
      case 'transcript': renderTranscript(m.messages || []); break;
      case 'taskProgress': {
        const card = taskCards.get(String(m.id)); if (!card) { break; }
        card.querySelector('.task-progress').textContent = VSGrokCards.taskProgressText(m);
        if (state.task && state.task.id === String(m.id)) {
          const stepChanged = (m.steps | 0) !== state.task.steps; state.task.steps = m.steps | 0; renderTaskPill();
          if (stepChanged && Date.now() - state.task.lastAnnounce >= 10000) { state.task.lastAnnounce = Date.now(); announce.textContent = 'Task step ' + (m.steps | 0) + ' of ' + (m.maxSteps | 0); }
        }
        if (m.label) { card.querySelector('.task-current').textContent = '→ ' + String(m.label); }
        break;
      }
      case 'taskLog': {
        const card = taskCards.get(String(m.id)); if (!card) { break; }
        const li = document.createElement('li'); li.className = m.auto ? 'auto' : 'asked'; li.textContent = (m.auto ? '✓ ' : '? ') + String(m.text);
        const log = card.querySelector('.task-log'); log.appendChild(li); while (log.children.length > 8) { log.firstChild.remove(); }
        break;
      }
      case 'taskEnd': taskEnd(m); break;
      case 'taskUndone': {
        const card = taskCards.get(String(m.id)); if (!card) { break; }
        card.querySelector('.approval-status').textContent = (m.ok ? '↶ ' : '⚠ ') + String(m.msg || '');
        if (m.ok) { card.dataset.state = 'undone'; }
        announce.textContent = String(m.msg || '');
        break;
      }
      case 'chatCleared': taskCards.clear(); approvalCards.clear(); messagesEl.innerHTML = ''; turns.clear(); state.streaming = null; setSendMode(false); break;
    }
  });

  renderChips();
  vscode.postMessage({ type: 'ready' });
})();
