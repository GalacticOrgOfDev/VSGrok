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
  /** Plan card view model. */
  function planSpec(r) {
    const files = (r && Array.isArray(r.files) ? r.files : []).map((f, i) => {
      const o = OP[f.op] || OP.modify;
      return { index: i, icon: o.icon, opLabel: o.label, path: String(f.path || '') + (f.op === 'rename' && f.newPath ? ' → ' + f.newPath : ''),
        delta: (f.op === 'delete' ? '' : '+' + (f.added | 0) + ' ') + '−' + (f.removed | 0), diff: true };
    });
    const tot = files.length;
    return { title: '✦ Grok proposes a plan · ' + tot + ' file' + (tot === 1 ? '' : 's'), summary: r && r.summary ? String(r.summary) : '', files };
  }
  function approveLabel(selected, total) { return selected === total ? 'Approve all (' + total + ')' : 'Approve selected (' + selected + '/' + total + ')'; }
  function problemsChip(count, enabled) {
    if (!count) { return { hidden: true }; }
    return { hidden: false, text: (enabled ? '⚠ ' : '⊘ ') + count + ' problem' + (count === 1 ? '' : 's'),
      tooltip: enabled ? 'Problems in the active and attached files are sent with your next message. Click to stop including them.' : 'Problems are not included. Click to include them with your next message.' };
  }

  return { ERR, errorSpec, rulesChip, firstLine, planSpec, approveLabel, problemsChip };
});
