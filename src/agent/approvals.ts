// In-chat approval cards. Every permission request (run_command, propose_edit, Apply/Fix diffs) is
// posted to the chat webview with a request id and resolved only by the user's Approve/Deny click there.
// Closing the panel, stopping, clearing the chat or cancelling the request resolves as deny.
// Pure module (no vscode import) so it is unit-testable.

export type ApprovalRequest =
  | { kind: 'command'; title?: string; command: string }
  | { kind: 'edit'; title?: string; path: string; reason?: string; isNew?: boolean; added?: number; removed?: number };

export interface ApprovalCardMessage { type: 'approvalRequest'; reqId: string; request: ApprovalRequest }
export interface ApprovalOptions { signal?: AbortSignal; onViewDiff?: () => void | Promise<void> }

interface Pending { resolve: (ok: boolean) => void; onViewDiff?: () => void | Promise<void>; cleanup: () => void }

export class ApprovalBroker {
  private pending = new Map<string, Pending>();
  private seq = 0;
  constructor(private readonly post: (msg: unknown) => void) {}

  get size(): number { return this.pending.size; }

  request(req: ApprovalRequest, opts: ApprovalOptions = {}): Promise<boolean> {
    if (opts.signal?.aborted) { return Promise.resolve(false); }
    const reqId = `ap${++this.seq}-${Date.now().toString(36)}`;
    return new Promise<boolean>((resolve) => {
      const onAbort = () => this.settle(reqId, false, 'cancelled');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(reqId, { resolve, onViewDiff: opts.onViewDiff, cleanup: () => opts.signal?.removeEventListener('abort', onAbort) });
      const msg: ApprovalCardMessage = { type: 'approvalRequest', reqId, request: req };
      this.post(msg);
    });
  }

  /** Handle a message from the webview. Returns true if it was an approval message. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(m: any): boolean {
    if (m?.type === 'approvalResponse' && typeof m.reqId === 'string') {
      this.settle(m.reqId, m.decision === 'approve', m.decision === 'approve' ? 'approved' : 'denied');
      return true;
    }
    if (m?.type === 'approvalViewDiff' && typeof m.reqId === 'string') {
      const p = this.pending.get(m.reqId);
      if (p?.onViewDiff) { void Promise.resolve(p.onViewDiff()).catch(() => undefined); }
      return true;
    }
    return false;
  }

  /** Deny everything still waiting (panel closed, stop, new chat). */
  cancelAll(reason = 'cancelled'): void {
    for (const id of [...this.pending.keys()]) { this.settle(id, false, reason); }
  }

  private settle(reqId: string, ok: boolean, state: string) {
    const p = this.pending.get(reqId);
    if (!p) { return; }
    this.pending.delete(reqId);
    p.cleanup();
    this.post({ type: 'approvalResolved', reqId, state });
    p.resolve(ok);
  }
}

type Approver = (req: ApprovalRequest, opts?: ApprovalOptions) => Promise<boolean>;
let approver: Approver | undefined;

/** Registered by the chat view. */
export function setApprover(a: Approver | undefined): void { approver = a; }

/** Ask the user in chat. With no chat available this denies (nothing runs without an explicit Approve). */
export function requestApproval(req: ApprovalRequest, opts?: ApprovalOptions): Promise<boolean> {
  return approver ? approver(req, opts) : Promise.resolve(false);
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
