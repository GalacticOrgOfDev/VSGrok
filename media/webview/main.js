// VSGrok chat webview. No inline handlers; all markdown sanitized with DOMPurify.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages'), input = $('input'), sendBtn = $('send'), chipsEl = $('chips');
  const pill = $('new-output'), announce = $('sr-announce');
  const state = { streaming: null, hasEditor: false, editorPath: undefined, chips: [], chipsExpanded: false };
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

  function renderTurn(t) {
    const wasNear = nearBottom();
    const r = md(t.raw, t.state === 'streaming');
    t.body.innerHTML = r.html;
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
  function renderChips() {
    chipsEl.innerHTML = '';
    const list = state.chips;
    chipsEl.hidden = list.length === 0;
    const shown = state.chipsExpanded ? list : list.slice(0, 4);
    shown.forEach((c) => chipsEl.appendChild(chipEl(c, true)));
    if (list.length > 4) {
      const more = document.createElement('button'); more.className = 'chip more';
      more.textContent = state.chipsExpanded ? 'Show less' : '+' + (list.length - 4) + ' more';
      more.addEventListener('click', () => { state.chipsExpanded = !state.chipsExpanded; renderChips(); });
      chipsEl.appendChild(more);
    }
  }

  function addUser(text, chips) {
    const el = document.createElement('div'); el.className = 'message user';
    const t = document.createElement('div'); t.className = 'user-text'; t.textContent = text; el.appendChild(t);
    if (chips && chips.length) { const row = document.createElement('div'); row.className = 'mini-chips'; chips.forEach((c) => row.appendChild(chipEl(c, false))); el.appendChild(row); }
    messagesEl.appendChild(el); messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function startTurn(id) {
    const el = document.createElement('div'); el.className = 'message assistant'; el.dataset.state = 'streaming';
    const tools = document.createElement('div'); tools.className = 'tool-events';
    const body = document.createElement('div'); body.className = 'body';
    body.innerHTML = '<span class="typing" aria-label="Grok is typing"><i></i><i></i><i></i></span>';
    el.appendChild(tools); el.appendChild(body); messagesEl.appendChild(el);
    const t = { id, el, body, tools, raw: '', timer: null, state: 'streaming' };
    turns.set(id, t); state.streaming = id; setSendMode(true);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return t;
  }

  function finishTurn(t, st, extra) {
    if (!t || t.state !== 'streaming') { return; }
    t.state = st; t.el.dataset.state = st;
    if (t.timer) { cancelAnimationFrame(t.timer); t.timer = null; }
    if (st !== 'error' || t.raw) { renderTurn(t); }
    if (!t.raw && st !== 'error') { t.body.innerHTML = ''; }
    const foot = document.createElement('div'); foot.className = 'msg-footer';
    if (st === 'stopped') { const s = document.createElement('span'); s.className = 'stopped-tag'; s.textContent = 'Stopped'; foot.appendChild(s); }
    if (st === 'error') {
      const e = document.createElement('div'); e.className = 'error-msg'; e.textContent = extra.msg;
      t.el.appendChild(e);
      if (extra.kind === 'missing_key' || extra.kind === 'auth') { foot.appendChild(btn('Set API Key', () => vscode.postMessage({ type: 'setApiKey' }))); }
      foot.appendChild(btn('Retry', () => vscode.postMessage({ type: 'regenerate' })));
    } else {
      foot.appendChild(btn('Copy message', (b) => { navigator.clipboard.writeText(t.raw); vscode.postMessage({ type: 'copyMessage' }); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy message'), 1500); }));
      const rg = btn('Regenerate', () => vscode.postMessage({ type: 'regenerate' })); rg.classList.add('regen-btn'); foot.appendChild(rg);
      if (extra && extra.meta) {
        const m = extra.meta; const parts = [];
        if (m.model) { parts.push(m.model); }
        if (m.completionTokens) { parts.push(m.completionTokens + ' tok'); }
        if (m.latencyMs) { parts.push((m.latencyMs / 1000).toFixed(1) + 's'); }
        const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = parts.join(' · '); foot.appendChild(meta);
      }
    }
    t.el.appendChild(foot);
    if (state.streaming === t.id) { state.streaming = null; setSendMode(false); }
    announce.textContent = st === 'done' ? 'Grok finished responding.' : st === 'stopped' ? 'Stopped.' : 'Error: ' + (extra && extra.msg);
  }
  function btn(txt, fn) { const b = document.createElement('button'); b.className = 'foot-btn'; b.textContent = txt; b.addEventListener('click', () => fn(b)); return b; }

  function setSendMode(streaming) {
    sendBtn.classList.toggle('stop', streaming);
    sendBtn.textContent = streaming ? '■' : '➤';
    sendBtn.setAttribute('aria-label', streaming ? 'Stop generating' : 'Send');
  }
  function stop() {
    if (!state.streaming) { return; }
    vscode.postMessage({ type: 'stop' });
    finishTurn(turns.get(state.streaming), 'stopped');
  }
  function send() {
    if (state.streaming) { return; }
    const text = input.value.trim();
    if (!text) { return; }
    vscode.postMessage({ type: 'query', text });
    input.value = ''; autoGrow();
  }
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
  $('add-ctx').addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }));
  $('clear-btn').addEventListener('click', () => vscode.postMessage({ type: 'clearChat' }));
  $('setkey-btn').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
  $('agent').addEventListener('change', (e) => vscode.postMessage({ type: 'setAgent', enabled: e.target.checked }));
  const sp = $('settings-panel');
  $('settings-btn').addEventListener('click', (e) => { const o = sp.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(o)); });
  const modelIn = $('model');
  modelIn.addEventListener('change', () => vscode.postMessage({ type: 'updateSettings', model: modelIn.value }));
  ['temperature', 'maxTokens'].forEach((k) => {
    const el = $(k), v = $(k + '-val');
    el.addEventListener('input', () => (v.textContent = el.value));
    el.addEventListener('change', () => vscode.postMessage({ type: 'updateSettings', [k]: Number(el.value) }));
  });

  // drag & drop from Explorer
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer; if (!dt) { return; }
    const raw = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || dt.getData('text/plain');
    const uris = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[a-z][\w+.-]*:/i.test(s));
    if (uris.length) { vscode.postMessage({ type: 'dropFiles', uris }); }
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    switch (m.type) {
      case 'settings':
        if (m.model) { modelIn.value = m.model; }
        if (m.temperature !== undefined) { $('temperature').value = m.temperature; $('temperature-val').textContent = m.temperature; }
        if (m.maxTokens !== undefined) { $('maxTokens').value = m.maxTokens; $('maxTokens-val').textContent = m.maxTokens; }
        $('agent').checked = !!m.agent; break;
      case 'userMessage': addUser(m.text, m.chips); break;
      case 'streamStart': startTurn(m.id); break;
      case 'streamChunk': { const t = turns.get(m.id); if (t && t.state === 'streaming') { t.raw += m.delta; scheduleRender(t); } break; }
      case 'toolEvent': { const t = turns.get(m.id); if (t) { const d = document.createElement('div'); d.className = 'tool-event'; d.textContent = m.text; t.tools.appendChild(d); } break; }
      case 'streamDone': finishTurn(turns.get(m.id), 'done', { meta: m.meta }); break;
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
      case 'toast': { const d = document.createElement('div'); d.className = 'toast'; d.textContent = m.msg; document.body.appendChild(d); setTimeout(() => d.remove(), 4000); break; }
      case 'chatCleared': messagesEl.innerHTML = ''; turns.clear(); state.streaming = null; setSendMode(false); break;
    }
  });

  renderChips();
  vscode.postMessage({ type: 'ready' });
})();
