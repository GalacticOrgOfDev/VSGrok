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
    const who = document.createElement('div'); who.className = 'who';
    if (iconSrc) { const av = document.createElement('img'); av.className = 'avatar'; av.src = iconSrc; av.alt = ''; who.appendChild(av); }
    const nm = document.createElement('span'); nm.textContent = 'Grok'; who.appendChild(nm); el.appendChild(who);
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
      t.el.appendChild(errorCard(extra, true));
    } else {
      foot.appendChild(btn('Copy message', (b) => { navigator.clipboard.writeText(t.raw); vscode.postMessage({ type: 'copyMessage' }); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy message'), 1500); }));
      const rg = btn('Regenerate', () => vscode.postMessage({ type: 'regenerate' })); rg.classList.add('regen-btn'); foot.appendChild(rg);
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
  $('rules-chip').addEventListener('click', () => vscode.postMessage({ type: 'openRules' }));
  $('add-ctx').addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }));
  $('clear-btn').addEventListener('click', () => vscode.postMessage({ type: 'clearChat' }));
  $('setkey-btn').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
  $('agent').addEventListener('change', (e) => vscode.postMessage({ type: 'setAgent', enabled: e.target.checked }));
  function setToggle(id, on, disabled) { const b = $(id); b.setAttribute('aria-pressed', String(!!on)); b.classList.toggle('on', !!on); b.disabled = !!disabled; }
  [['web-toggle', 'web'], ['x-toggle', 'x']].forEach(([id, tool]) => {
    $(id).addEventListener('click', (e) => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; setToggle(id, on); vscode.postMessage({ type: 'setServerTool', tool, enabled: on }); });
  });
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
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer; if (!dt) { return; }
    const raw = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || dt.getData('text/plain');
    const uris = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[a-z][\w+.-]*:/i.test(s));
    if (uris.length) { vscode.postMessage({ type: 'dropFiles', uris }); }
  });


  // In-chat approval cards (commands, edits). Text only via textContent; decision goes back with reqId.
  const approvalCards = new Map();
  function addApprovalCard(reqId, r) {
    if (!r || approvalCards.has(reqId)) { return; }
    const wasNear = nearBottom();
    const card = document.createElement('div'); card.className = 'approval-card'; card.dataset.kind = r.kind === 'command' ? 'command' : 'edit';
    card.setAttribute('role', 'group');
    const head = document.createElement('div'); head.className = 'approval-head';
    head.textContent = r.kind === 'command' ? '⚡ Grok wants to run a command' : (r.isNew ? '✦ Grok wants to create a file' : '✦ Grok wants to edit a file');
    card.setAttribute('aria-label', head.textContent);
    card.appendChild(head);
    if (r.kind === 'command') {
      const pre = document.createElement('pre'); pre.className = 'approval-cmd'; pre.textContent = String(r.command || ''); card.appendChild(pre);
    } else {
      const p = document.createElement('div'); p.className = 'approval-path'; p.textContent = String(r.path || ''); card.appendChild(p);
      const meta = document.createElement('div'); meta.className = 'approval-meta';
      const delta = (typeof r.added === 'number' ? '+' + r.added : '') + (typeof r.removed === 'number' ? ' −' + r.removed : '');
      meta.textContent = [r.reason ? String(r.reason) : '', delta.trim()].filter(Boolean).join(' · '); card.appendChild(meta);
    }
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'approval-btn ' + cls; b.textContent = label; b.addEventListener('click', fn); actions.appendChild(b); return b; };
    const decide = (decision) => { card.classList.add('pending'); actions.querySelectorAll('button').forEach(b => (b.disabled = true)); vscode.postMessage({ type: 'approvalResponse', reqId, decision }); };
    const ok = mk(r.kind === 'command' ? 'Run' : 'Approve', 'approve', () => decide('approve'));
    mk('Deny', 'deny', () => decide('deny'));
    if (r.kind === 'edit') { mk('View diff', 'diff', () => vscode.postMessage({ type: 'approvalViewDiff', reqId })); }
    card.appendChild(actions);
    const status = document.createElement('div'); status.className = 'approval-status'; status.setAttribute('aria-live', 'polite'); card.appendChild(status);
    const t = state.streaming ? turns.get(state.streaming) : null;
    (t && t.tools ? t.tools : messagesEl).appendChild(card);
    approvalCards.set(reqId, card);
    stick(wasNear);
    ok.focus({ preventScroll: true });
    announce.textContent = 'Approval needed: ' + head.textContent;
  }
  function resolveApprovalCard(reqId, st) {
    const card = approvalCards.get(reqId); if (!card) { return; }
    approvalCards.delete(reqId);
    card.classList.remove('pending'); card.dataset.state = st;
    const acts = card.querySelector('.approval-actions'); if (acts) { acts.remove(); }
    card.querySelector('.approval-status').textContent = st === 'approved' ? '✓ Approved' : st === 'denied' ? '✕ Denied' : '⊘ ' + (st === 'panel reloaded' ? 'Cancelled (panel reloaded)' : st === 'panel closed' ? 'Cancelled (panel closed)' : 'Cancelled');
  }

  // In-chat update card (GitHub releases). One card, refreshed in place.
  let updateCardEl = null;
  function renderUpdateCard(c) {
    if (!c) { return; }
    const wasNear = nearBottom();
    if (!updateCardEl || !updateCardEl.isConnected) { updateCardEl = document.createElement('div'); updateCardEl.className = 'approval-card update-card'; updateCardEl.dataset.kind = 'edit'; messagesEl.appendChild(updateCardEl); }
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

  // Friendly error cards (API errors from chat, commands and fixes). Text only.
  const ERR = {
    missing_key: ['🔑', 'Connect Grok', 'No xAI API key is set yet.'],
    auth: ['🔑', 'xAI rejected the API key', 'The key is invalid, revoked, or lacks access to this model.'],
    quota_exceeded: ['💳', 'Out of xAI credits', 'Your xAI account has no credits or hit its spending limit.'],
    rate_limit: ['⏳', 'Grok is rate-limited', 'xAI asked us to slow down. VSGrok already retried with backoff.'],
    server: ['🛰', 'xAI is having trouble', 'xAI returned a server error. VSGrok already retried.'],
    offline: ['📡', "You're offline", "VSGrok can't reach api.x.ai. Check your connection, proxy or vsgrok.baseUrl."],
    network: ['📡', 'Connection dropped', 'The connection to xAI was interrupted.'],
    timeout: ['⌛', 'Request timed out', 'xAI sent no data for too long. Try again, or raise vsgrok.requestTimeoutSeconds.'],
    context_length: ['📚', 'Too much context', 'The request is larger than the model context window. Remove some context chips or start a new chat.'],
    generic: ['⚠', 'Something went wrong', ''],
  };
  function errorCard(e, inTurn) {
    const kind = ERR[e.kind] ? e.kind : 'generic'; const d = ERR[kind];
    const card = document.createElement('div'); card.className = 'error-card'; card.dataset.kind = kind; card.setAttribute('role', 'alert');
    const head = document.createElement('div'); head.className = 'error-head';
    const ic = document.createElement('span'); ic.className = 'error-icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = d[0];
    const ti = document.createElement('span'); ti.textContent = d[1] + (e.source ? ' · ' + String(e.source).replace(/^Grok: /, '').replace(/…$/, '') : '');
    head.append(ic, ti); card.appendChild(head);
    if (d[2]) { const h = document.createElement('div'); h.className = 'error-hint'; h.textContent = d[2]; card.appendChild(h); }
    const det = document.createElement('details'); det.className = 'error-detail';
    const sm = document.createElement('summary'); sm.textContent = 'Details' + (e.attempts > 1 ? ' (' + e.attempts + ' attempts)' : ''); det.appendChild(sm);
    const pre = document.createElement('pre'); pre.textContent = String(e.msg || ''); det.appendChild(pre); card.appendChild(det);
    const acts = document.createElement('div'); acts.className = 'approval-actions';
    const b = (label, cls, fn) => { const x = document.createElement('button'); x.className = 'approval-btn ' + cls; x.textContent = label; x.addEventListener('click', fn); acts.appendChild(x); };
    if (kind === 'missing_key' || kind === 'auth') { b('Set API Key', 'approve', () => vscode.postMessage({ type: 'setApiKey' })); }
    if (kind === 'quota_exceeded') { b('Open xAI Console', 'approve', () => vscode.postMessage({ type: 'openLink', url: 'https://console.x.ai' })); }
    if (inTurn && kind !== 'missing_key') { b('Retry', kind === 'auth' || kind === 'quota_exceeded' ? 'deny' : 'approve', () => vscode.postMessage({ type: 'regenerate' })); }
    b('Copy diagnostics', 'deny', () => vscode.postMessage({ type: 'copyDiagnostics' }));
    if (!inTurn) { b('Dismiss', 'deny', () => card.remove()); }
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
      case 'userMessage': addUser(m.text, m.chips); break;
      case 'streamStart': startTurn(m.id); break;
      case 'streamChunk': { const t = turns.get(m.id); if (t && t.state === 'streaming') { t.raw += m.delta; scheduleRender(t); } break; }
      case 'toolEvent': {
        const t = turns.get(m.id); if (!t) { break; }
        let d = m.toolId ? t.tools.querySelector('[data-tool-id="' + String(m.toolId).replace(/[^\w-]/g, '') + '"]') : null;
        if (!d) {
          d = document.createElement('details'); d.className = 'tool-event'; if (m.toolId) { d.dataset.toolId = String(m.toolId); }
          const sm = document.createElement('summary'); d.appendChild(sm); t.tools.appendChild(d);
        }
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
      case 'errorCard': { const wn = nearBottom(); if (m.card) { messagesEl.appendChild(errorCard(m.card, false)); } stick(wn); break; }
      case 'rules': {
        const rc = $('rules-chip'); const files = Array.isArray(m.files) ? m.files : [];
        rc.hidden = !files.length;
        rc.textContent = '📜 Rules';
        rc.title = files.length ? 'Project rules active: ' + files.join(', ') + (m.truncated ? ' (truncated to 20k chars)' : '') + '. Grok follows them in every chat. Click to open.' : '';
        rc.setAttribute('aria-label', rc.title || 'Project rules');
        break;
      }
      case 'toast': { const d = document.createElement('div'); d.className = 'toast'; d.textContent = m.msg; document.body.appendChild(d); setTimeout(() => d.remove(), 4000); break; }
      case 'chatCleared': approvalCards.clear(); messagesEl.innerHTML = ''; turns.clear(); state.streaming = null; setSendMode(false); break;
    }
  });

  renderChips();
  vscode.postMessage({ type: 'ready' });
})();
