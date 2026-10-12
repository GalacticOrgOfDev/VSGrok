// MCP client manager (official @modelcontextprotocol/sdk): stdio and streamable-HTTP servers from settings
// (vsgrok.mcp.servers) and .vscode/vsgrok-mcp.json (trusted workspaces only). Tools are exposed to Grok as function
// tools named mcp__<server>__<tool>; every call goes through the in-chat approval card unless the user chose
// "Always allow" for that tool (tied to the server's launch config).
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cfg } from './config';
import { requestDecision } from './agent/approvals';
import { diag } from './diagnostics';
import { McpServerConfig, McpToolInfo, parseServers, mergeServers, configHash, functionName, toFunctionTool, formatResult, argsPreview, MAX_TOOLS_PER_SERVER } from './mcpCore';

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const ALLOW_KEY = 'vsgrok.mcp.alwaysAllow';
export const WORKSPACE_FILE = '.vscode/vsgrok-mcp.json';

interface Conn {
  cfg: McpServerConfig; hash: string;
  client?: Client; status: 'connecting' | 'ready' | 'error' | 'disabled'; error?: string;
  tools: { fn: string; info: McpToolInfo }[];
}

export class McpManager implements vscode.Disposable {
  private conns = new Map<string, Conn>();
  private byFn = new Map<string, { server: string; tool: string }>();
  private errors: string[] = [];
  private loading?: Promise<void>;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0] ?? '/', WORKSPACE_FILE));
    this.subs.push(this.emitter, watcher,
      watcher.onDidChange(() => this.reload()), watcher.onDidCreate(() => this.reload()), watcher.onDidDelete(() => this.reload()),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vsgrok.mcp')) { this.reload(); } }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.reload()),
    );
  }

  dispose() { for (const s of this.subs) { s.dispose(); } void this.closeAll(); }

  /** Configured servers: user settings, plus the workspace file when the workspace is trusted. */
  async readConfig(): Promise<{ servers: McpServerConfig[]; errors: string[]; workspaceSkipped: boolean }> {
    const user = parseServers(cfg().get('mcp.servers'), 'settings');
    let ws: { servers: McpServerConfig[]; errors: string[] } = { servers: [], errors: [] };
    let workspaceSkipped = false;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root) {
      const f = vscode.Uri.joinPath(root, WORKSPACE_FILE);
      let text: string | undefined;
      try { text = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8'); } catch { /* none */ }
      if (text !== undefined) {
        if (!vscode.workspace.isTrusted) { workspaceSkipped = true; }
        else { try { ws = parseServers(JSON.parse(text), 'workspace'); } catch (e) { ws.errors.push(`${WORKSPACE_FILE}: ${(e as Error).message}`); } }
      }
    }
    const m = mergeServers(user.servers, ws.servers);
    return { servers: m.servers, errors: [...user.errors, ...ws.errors, ...m.errors], workspaceSkipped };
  }

  /** Loads are serialized: a reload waits for the one in flight, so connections never interleave. */
  reload(): void { const prev = this.loading ?? Promise.resolve(); this.loading = prev.catch(() => undefined).then(() => this.doLoad()); void this.loading.finally(() => this.emitter.fire()); }
  /** Start (or wait for) the initial load. */
  ready(): Promise<void> { if (!this.loading) { this.reload(); } return this.loading!; }

  private async doLoad(): Promise<void> {
    await this.closeAll();
    const { servers, errors, workspaceSkipped } = await this.readConfig();
    this.errors = [...errors, ...(workspaceSkipped ? [`${WORKSPACE_FILE} ignored: the workspace is not trusted`] : [])];
    const taken = new Set<string>();
    await Promise.all(servers.map(async s => {
      const c: Conn = { cfg: s, hash: configHash(s), status: s.disabled ? 'disabled' : 'connecting', tools: [] };
      this.conns.set(s.name, c);
      if (s.disabled) { return; }
      try {
        const client = new Client({ name: 'vsgrok', version: String(this.ctx.extension?.packageJSON?.version ?? '0') });
        const transport = s.type === 'stdio'
          ? new StdioClientTransport({ command: s.command, args: s.args, env: s.env, cwd: s.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, stderr: 'ignore' })
          : new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers } });
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect to ${s.name}`);
        c.client = client;
        const list = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `list tools of ${s.name}`);
        c.tools = (list.tools ?? []).slice(0, MAX_TOOLS_PER_SERVER).map(t => ({ fn: '', info: { name: t.name, description: t.description, inputSchema: t.inputSchema } }));
        c.status = 'ready';
      } catch (e) {
        c.status = 'error'; c.error = (e as Error).message.slice(0, 300);
        diag('mcp.error', { server: s.name, msg: c.error });
      }
    }));
    // Names assigned in config order so they are stable.
    this.byFn.clear();
    for (const c of this.conns.values()) { for (const t of c.tools) { t.fn = functionName(c.cfg.name, t.info.name, taken); this.byFn.set(t.fn, { server: c.cfg.name, tool: t.info.name }); } }
  }

  private async closeAll() {
    const cs = [...this.conns.values()]; this.conns.clear(); this.byFn.clear();
    await Promise.all(cs.map(c => c.client?.close().catch(() => undefined)));
  }

  /** Function tools for the Responses API (ready servers only). */
  functionTools() {
    const out: ReturnType<typeof toFunctionTool>[] = [];
    for (const c of this.conns.values()) { if (c.status === 'ready') { for (const t of c.tools) { out.push(toFunctionTool(c.cfg.name, t.fn, t.info)); } } }
    return out;
  }
  isMcpTool(name: string) { return this.byFn.has(name); }
  status() {
    return { errors: this.errors, servers: [...this.conns.values()].map(c => ({ name: c.cfg.name, type: c.cfg.type, source: c.cfg.source, status: c.status, error: c.error, tools: c.tools.map(t => t.info.name) })) };
  }

  private allowList(): string[] { return this.ctx.globalState.get<string[]>(ALLOW_KEY) ?? []; }
  private allowKey(c: Conn, tool: string) { return `${c.cfg.name}#${c.hash}/${tool}`; }
  async resetAlwaysAllow() { await this.ctx.globalState.update(ALLOW_KEY, []); }

  /** Run one MCP tool call: approval card (or always-allow), then call with timeout/cancel. */
  async call(fn: string, args: unknown, token: vscode.CancellationToken): Promise<string> {
    const m = this.byFn.get(fn);
    const c = m && this.conns.get(m.server);
    if (!m || !c?.client || c.status !== 'ready') { return `Error: MCP tool ${fn} is not available (server not connected).`; }
    const key = this.allowKey(c, m.tool);
    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());
    try {
      if (!this.allowList().includes(key)) {
        const d = await requestDecision({ kind: 'mcp', server: m.server, tool: m.tool, args: argsPreview(args), source: c.cfg.source }, { signal: ac.signal });
        if (!d.ok) { return `User declined the MCP tool call ${m.server}/${m.tool}.`; }
        if (d.always) { await this.ctx.globalState.update(ALLOW_KEY, [...new Set([...this.allowList(), key])].slice(-500)); }
      }
      const res = await c.client.callTool({ name: m.tool, arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> }, undefined, { signal: ac.signal, timeout: CALL_TIMEOUT_MS });
      diag('mcp.call', { server: m.server, isError: !!res.isError });
      return formatResult(m.server, m.tool, res);
    } catch (e) {
      return `Error: MCP ${m.server}/${m.tool} failed: ${(e as Error).message.slice(0, 500)}`;
    } finally { sub.dispose(); }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`timed out trying to ${what}`)), ms); })]).finally(() => clearTimeout(t));
}

let manager: McpManager | undefined;
export function setMcpManager(m: McpManager | undefined) { manager = m; }
export function mcp(): McpManager | undefined { return manager; }
