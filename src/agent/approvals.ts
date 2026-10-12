// In-chat approval cards. Every permission request (run_command, propose_edit, Apply/Fix diffs) is
// posted to the chat webview with a request id and resolved only by the user's Approve/Deny click there.
// Closing the panel, stopping, clearing the chat or cancelling the request resolves as deny.
// Pure module (no vscode import) so it is unit-testable.

export type ApprovalRequest =
  | { kind: 'command'; title?: string; command: string; runs?: string[]; source?: string; repoControlled?: boolean }
  | { kind: 'edit'; title?: string; path: string; reason?: string; isNew?: boolean; added?: number; removed?: number }
  | { kind: 'plan'; title?: string; summary?: string; files: { path: string; op: 'create' | 'modify' | 'delete' | 'rename'; newPath?: string; added: number; removed: number; refused?: string; warn?: string }[] };

export interface ApprovalDecision { ok: boolean; selected?: number[] }

export interface ApprovalCardMessage { type: 'approvalRequest'; reqId: string; request: ApprovalRequest }
export interface ApprovalOptions { signal?: AbortSignal; onViewDiff?: (index?: number) => void | Promise<void> }

interface Pending { selectable?: number; resolve: (d: ApprovalDecision) => void; onViewDiff?: (index?: number) => void | Promise<void>; cleanup: () => void }

export class ApprovalBroker {
  private pending = new Map<string, Pending>();
  private seq = 0;
  constructor(private readonly post: (msg: unknown) => void) {}

  get size(): number { return this.pending.size; }

  request(req: ApprovalRequest, opts: ApprovalOptions = {}): Promise<boolean> {
    return this.requestDecision(req, opts).then(d => d.ok);
  }

  /** Like request(), but also returns the user's per-item selection (plan cards). */
  requestDecision(req: ApprovalRequest, opts: ApprovalOptions = {}): Promise<ApprovalDecision> {
    if (opts.signal?.aborted) { return Promise.resolve({ ok: false }); }
    const reqId = `ap${++this.seq}-${Date.now().toString(36)}`;
    return new Promise<ApprovalDecision>((resolve) => {
      const onAbort = () => this.settle(reqId, false, 'cancelled');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(reqId, { selectable: req.kind === 'plan' ? req.files.filter(f => !f.refused).length : undefined, resolve, onViewDiff: opts.onViewDiff, cleanup: () => opts.signal?.removeEventListener('abort', onAbort) });
      const msg: ApprovalCardMessage = { type: 'approvalRequest', reqId, request: req };
      this.post(msg);
    });
  }

  /** Handle a message from the webview. Returns true if it was an approval message. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(m: any): boolean {
    if (m?.type === 'approvalResponse' && typeof m.reqId === 'string') {
      const ok = m.decision === 'approve';
      const lim = this.pending.get(m.reqId)?.selectable;
      // Plan cards: only indices of selectable (non-refused) rows count; an approve without any is a deny.
      const selected = ok && Array.isArray(m.selected) ? [...new Set(m.selected.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < (lim ?? 1000)) as number[])] : undefined;
      if (ok && ((selected && !selected.length) || (lim !== undefined && !selected))) { this.settle(m.reqId, false, 'denied'); return true; }
      this.settle(m.reqId, ok, ok ? 'approved' : 'denied', selected);
      return true;
    }
    if (m?.type === 'approvalViewDiff' && typeof m.reqId === 'string') {
      const p = this.pending.get(m.reqId);
      if (p?.onViewDiff) { void Promise.resolve(p.onViewDiff(Number.isInteger(m.index) ? m.index : undefined)).catch(() => undefined); }
      return true;
    }
    return false;
  }

  /** Deny everything still waiting (panel closed, stop, new chat). */
  cancelAll(reason = 'cancelled'): void {
    for (const id of [...this.pending.keys()]) { this.settle(id, false, reason); }
  }

  private settle(reqId: string, ok: boolean, state: string, selected?: number[]) {
    const p = this.pending.get(reqId);
    if (!p) { return; }
    this.pending.delete(reqId);
    p.cleanup();
    this.post({ type: 'approvalResolved', reqId, state });
    p.resolve({ ok, selected: ok ? selected : undefined });
  }
}

type Approver = (req: ApprovalRequest, opts?: ApprovalOptions) => Promise<ApprovalDecision>;
let approver: Approver | undefined;

/** Registered by the chat view. */
export function setApprover(a: Approver | undefined): void { approver = a; }

/** Ask the user in chat. With no chat available this denies (nothing runs without an explicit Approve). */
export function requestApproval(req: ApprovalRequest, opts?: ApprovalOptions): Promise<boolean> {
  return requestDecision(req, opts).then(d => d.ok);
}
export function requestDecision(req: ApprovalRequest, opts?: ApprovalOptions): Promise<ApprovalDecision> {
  return approver ? approver(req, opts) : Promise.resolve({ ok: false });
}

/** Rough added/removed line counts for the card summary (multiset line diff). */
export function lineDelta(oldText: string, newText: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  const a = oldText ? oldText.split('\n') : [];
  const b = newText ? newText.split('\n') : [];
  for (const l of a) { count.set(l, (count.get(l) ?? 0) + 1); }
  let added = 0;
  for (const l of b) { const c = count.get(l) ?? 0; if (c > 0) { count.set(l, c - 1); } else { added++; } }
  let removed = 0;
  for (const c of count.values()) { removed += c; }
  return { added, removed };
}
