// Pure view-model helpers for the chat webview (error cards, Rules chip). UMD: window.VSGrokCards in the webview, require() in unit tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.VSGrokCards = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // severity: error (red) | warn (amber) | info (cyan)
  const ERR = {
    missing_key: { icon: '🔑', title: 'Connect Grok', hint: 'Add your xAI API key to start chatting.', sev: 'info' },
    auth: { icon: '🔑', title: 'xAI rejected the API key', hint: 'The key is invalid, revoked, or lacks access to this model.', sev: 'error' },
    quota_exceeded: { icon: '💳', title: 'Out of xAI credits', hint: 'Your xAI account has no credits left or hit its spending limit.', sev: 'error' },
    rate_limit: { icon: '⏳', title: 'Rate limited by xAI', hint: 'xAI asked us to slow down. VSGrok already retried with backoff.', sev: 'warn' },
    server: { icon: '🛰', title: 'xAI is having trouble', hint: 'xAI returned a server error. VSGrok already retried.', sev: 'error' },
    offline: { icon: '📡', title: "You're offline", hint: "VSGrok can't reach the xAI API. Check your connection or proxy, or the API base URL setting.", sev: 'warn' },
    network: { icon: '📡', title: 'Connection dropped', hint: 'The connection to xAI was interrupted.', sev: 'warn' },
    timeout: { icon: '⌛', title: 'Request timed out', hint: 'xAI sent no data for too long. Try again, or raise the request timeout.', sev: 'warn' },
    context_length: { icon: '📚', title: 'Too much context', hint: 'The request is larger than the model context window. Remove some context chips or start a new chat.', sev: 'error' },
    generic: { icon: '⚠', title: 'Something went wrong', hint: '', sev: 'error' },
  };

  function firstLine(s, max) { const l = String(s || '').split('\n').map(x => x.trim()).find(Boolean) || ''; return l.length > max ? l.slice(0, max - 1) + '…' : l; }

  /** e: {kind,msg,source,attempts}; inTurn: card is inside an assistant reply (Retry available). */
  function errorSpec(e, inTurn) {
    const kind = Object.prototype.hasOwnProperty.call(ERR, e && e.kind) ? e.kind : 'generic';
    const d = ERR[kind];
    const src = e && e.source ? String(e.source).replace(/^Grok: /, '').replace(/…$/, '') : '';
    const actions = [];
    const add = (label, primary, msg) => actions.push({ label, primary: !!primary, msg });
    if (kind === 'missing_key' || kind === 'auth') { add('Set API Key', true, { type: 'setApiKey' }); }
    if (kind === 'quota_exceeded') { add('Open xAI Console', true, { type: 'openLink', url: 'https://console.x.ai' }); }
    if (kind === 'offline') { add('Open Settings', false, { type: 'openSettings', key: 'vsgrok.baseUrl' }); }
    if (kind === 'timeout') { add('Open Settings', false, { type: 'openSettings', key: 'vsgrok.requestTimeoutSeconds' }); }
    if (kind === 'context_length') { add('New chat', true, { type: 'clearChat' }); }
    if (inTurn && kind !== 'missing_key') { add('Retry', !actions.some(a => a.primary), { type: 'regenerate' }); }
    add('Copy diagnostics', false, { type: 'copyDiagnostics' });
    return {
      kind, sev: d.sev, icon: d.icon, title: d.title, source: src,
      hint: d.hint || firstLine(e && e.msg, 120),
      detailsLabel: 'Details' + (e && e.attempts > 1 ? ' (' + e.attempts + ' attempts)' : ''),
      details: String((e && e.msg) || ''),
      actions, dismissible: !inTurn,
    };
  }

  function rulesChip(files, truncated) {
    const f = Array.isArray(files) ? files.filter(Boolean).map(String) : [];
    if (!f.length) { return { hidden: true, label: '', count: '', tooltip: '' }; }
    return {
      hidden: false, label: 'Rules', count: f.length > 1 ? ' · ' + f.length : '',
      tooltip: 'Project rules (' + f.length + '): ' + f.join(', ') + '.' + (truncated ? ' (trimmed to 20k chars)' : '') + ' Added to every chat. Click to open.',
    };
  }

  const OP = { create: { icon: '＋', label: 'new' }, modify: { icon: '✎', label: 'edit' }, delete: { icon: '🗑', label: 'delete' }, rename: { icon: '➜', label: 'rename' } };
  /** Plan card view model. Refused rows are shown but never selectable. */
  function planSpec(r) {
    const files = (r && Array.isArray(r.files) ? r.files : []).map((f, i) => {
      const o = OP[f.op] || OP.modify; const op = OP[f.op] ? f.op : 'modify';
      const added = f.added | 0, removed = f.removed | 0;
      return { index: i, op, icon: o.icon, opLabel: o.label, path: String(f.path || ''), newPath: op === 'rename' && f.newPath ? String(f.newPath) : '',
        delta: f.refused ? '' : (op === 'delete' ? '' : '+' + added + ' ') + '−' + removed,
        deltaLabel: f.refused ? '' : (op === 'delete' ? removed + ' lines removed' : added + ' lines added, ' + removed + ' removed'),
        refused: !!f.refused, reason: f.refused ? String(typeof f.refused === 'string' ? f.refused : (f.reason || 'refused')) : '', diff: !f.refused, warn: f.warn && !f.refused ? String(f.warn) : '' };
    });
    const usable = files.filter(f => !f.refused);
    const n = { create: 0, modify: 0, delete: 0, rename: 0 }; usable.forEach(f => n[f.op]++);
    const pl = (k, one, many) => n[k] ? n[k] + ' ' + (n[k] === 1 ? one : many) : '';
    const refusedN = files.length - usable.length;
    const meta = [pl('create', 'new', 'new'), pl('modify', 'edit', 'edits'), pl('rename', 'rename', 'renames'), pl('delete', 'delete', 'deletes'), refusedN ? refusedN + ' refused' : ''].filter(Boolean).join(' · ');
    const tot = usable.length;
    return { title: '✦ Grok proposes a plan · ' + tot + ' file' + (tot === 1 ? '' : 's'), meta, hasDelete: n.delete > 0, summary: r && r.summary ? String(r.summary) : '', files, usable: tot };
  }
  /** Split a path into segments that may break after each "/". */
  function pathParts(p) { return String(p).split(/(?<=\/)/); }
  function approveLabel(selected, total) { return selected === total ? 'Approve all (' + total + ')' : 'Approve selected (' + selected + '/' + total + ')'; }
  function problemsChip(count, enabled) {
    if (!count) { return { hidden: true }; }
    const noun = 'problem' + (count === 1 ? '' : 's');
    return { hidden: false, glyph: enabled ? '⚠' : '⊘', text: count + ' ' + noun, ariaLabel: 'Include ' + count + ' ' + noun,
      tooltip: enabled ? 'Problems from the active and attached files are sent with each message. Click to stop.' : 'Problems aren\'t being sent. Click to include them.' };
  }
  /** Tri-state for the plan card's Select all box. */
  function selectAllState(checked, total) { return { checked: total > 0 && checked === total, indeterminate: checked > 0 && checked < total }; }

  // ---- images ----
  const IMG = { MAX: 8, SIDE: 2048, BYTES: 4 * 1024 * 1024 };
  /** Scale (w,h) so the long side is at most max. */
  function fitSize(w, h, max) {
    max = max || IMG.SIDE; const k = Math.max(w, h) > max ? max / Math.max(w, h) : 1;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: k < 1 };
  }
  /** Bytes encoded in a base64 data URL. */
  function dataUrlBytes(u) { const i = String(u).indexOf(','); const b = i < 0 ? '' : String(u).slice(i + 1); return Math.floor(b.length * 3 / 4) - (b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0); }
  /** Can a source data URL be sent as-is (already PNG/JPEG, small enough, not oversized)? */
  function keepOriginal(mime, bytes, w, h) { return (mime === 'image/png' || mime === 'image/jpeg') && bytes <= IMG.BYTES && Math.max(w, h) <= IMG.SIDE; }
  /** Room left for images (count cap). */
  function imageRoom(current, adding) { const room = Math.max(0, IMG.MAX - current); return { take: Math.min(room, adding), dropped: Math.max(0, adding - room) }; }
  function visionNote(model, suggest) {
    return { title: '🖼 ' + model + ' can\'t read images', body: suggest ? model + ' doesn\'t accept image input.' : 'None of your available models report image input. Send without images, or remove them.', action: suggest ? 'Switch to ' + suggest + ' and resend' : '' };
  }
  function imagesOnlyPrompt(n) { return n > 1 ? 'What is in these images?' : 'What is in this image?'; }
  function toastMs(text) { return 6000 + Math.ceil(String(text).length / 40) * 1000; }

  // ---- background task card ----
  function fmtTok(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
  function taskProgressText(p) {
    const parts = ['Step ' + (p.steps | 0) + ' of ' + (p.maxSteps | 0), fmtTok(p.tokens) + ' tokens'];
    if (typeof p.costUsd === 'number') { parts.push('$' + p.costUsd.toFixed(p.costUsd < 0.1 ? 3 : 2)); }
    if (p.autoApproved) { parts.push(p.autoApproved + ' auto-approved'); }
    if (p.asked) { parts.push(p.asked + ' asked'); }
    return parts.join(' · ');
  }
  function taskEndHead(outcome, nFiles) {
    const files = nFiles + ' file' + (nFiles === 1 ? '' : 's') + ' changed';
    switch (outcome) {
      case 'stopped': return '■ Task stopped · ' + files;
      case 'budget': return '⚠ Task stopped at its budget · ' + files;
      case 'steps': return '⚠ Task hit its step limit · ' + files;
      case 'error': return '✕ Task failed · ' + files;
      default: return '✓ Task finished · ' + files;
    }
  }
  function levelLabel(l) { return l === 'editsAndCommands' ? 'Auto-approving workspace edits and allowlisted commands' : l === 'safeEdits' ? 'Auto-approving workspace edits' : 'Asking before every edit and command'; }

  // ---- history ----
  function relTime(ts, now) {
    const s = Math.max(0, Math.round(((now || Date.now()) - ts) / 1000));
    if (s < 60) { return 'just now'; }
    if (s < 3600) { return Math.floor(s / 60) + ' min ago'; }
    if (s < 86400) { return Math.floor(s / 3600) + ' h ago'; }
    const d = Math.floor(s / 86400); return d === 1 ? 'yesterday' : d + ' days ago';
  }
  return { relTime, fmtTok, taskProgressText, taskEndHead, levelLabel, IMG, fitSize, dataUrlBytes, keepOriginal, imageRoom, visionNote, imagesOnlyPrompt, toastMs, ERR, errorSpec, rulesChip, firstLine, planSpec, approveLabel, problemsChip, pathParts, selectAllState };
});
