// MCP: config parsing/validation, tool name mapping, result formatting. Pure; unit-tested.
import { createHash } from 'crypto';

export type McpServerConfig =
  | { name: string; source: 'settings' | 'workspace'; type: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string; disabled?: boolean }
  | { name: string; source: 'settings' | 'workspace'; type: 'http'; url: string; headers: Record<string, string>; disabled?: boolean };

export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_SERVERS = 20;
export const MAX_TOOLS_PER_SERVER = 100;
export const MAX_RESULT_CHARS = 50_000;
export const TOOL_PREFIX = 'mcp__';

const strMap = (v: unknown): Record<string, string> | undefined => {
  if (v === undefined) { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) { return undefined; }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) { if (typeof x !== 'string') { return undefined; } out[k] = x; }
  return out;
};

/** Parse `{ servers: {...} }` / `{ mcpServers: {...} }` / a bare map. Invalid entries are reported, not thrown. */
export function parseServers(raw: unknown, source: 'settings' | 'workspace'): { servers: McpServerConfig[]; errors: string[] } {
  const errors: string[] = []; const servers: McpServerConfig[] = [];
  if (raw === undefined || raw === null) { return { servers, errors }; }
  if (typeof raw !== 'object' || Array.isArray(raw)) { return { servers, errors: [`${source}: expected an object of servers`] }; }
  const r = raw as Record<string, unknown>;
  const map = (r.servers ?? r.mcpServers ?? r) as Record<string, unknown>;
  if (!map || typeof map !== 'object' || Array.isArray(map)) { return { servers, errors: [`${source}: "servers" must be an object`] }; }
  for (const [name, v] of Object.entries(map)) {
    if (servers.length >= MAX_SERVERS) { errors.push(`${source}: more than ${MAX_SERVERS} servers; the rest are ignored`); break; }
    if (!NAME_RE.test(name)) { errors.push(`${source}: server name "${name.slice(0, 40)}" must be 1-32 letters, digits, _ or -`); continue; }
    if (!v || typeof v !== 'object') { errors.push(`${name}: expected an object`); continue; }
    const c = v as Record<string, unknown>;
    const disabled = c.disabled === true || c.enabled === false;
    const url = c.url;
    if (typeof url === 'string' || c.type === 'http' || c.type === 'streamable-http') {
      let u: URL;
      try { u = new URL(String(url)); } catch { errors.push(`${name}: invalid url`); continue; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') { errors.push(`${name}: url must be http(s)`); continue; }
      if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) { errors.push(`${name}: plain http is only allowed for localhost; use https`); continue; }
      const headers = strMap(c.headers);
      if (!headers) { errors.push(`${name}: headers must map names to strings`); continue; }
      servers.push({ name, source, type: 'http', url: u.toString(), headers, disabled });
      continue;
    }
    if (typeof c.command !== 'string' || !c.command.trim()) { errors.push(`${name}: needs "command" (stdio) or "url" (streamable HTTP)`); continue; }
    const args = c.args === undefined ? [] : c.args;
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) { errors.push(`${name}: args must be an array of strings`); continue; }
    const env = strMap(c.env);
    if (!env) { errors.push(`${name}: env must map names to strings`); continue; }
    if (c.cwd !== undefined && typeof c.cwd !== 'string') { errors.push(`${name}: cwd must be a string`); continue; }
    servers.push({ name, source, type: 'stdio', command: c.command.trim(), args: args as string[], env, cwd: c.cwd as string | undefined, disabled });
  }
  return { servers, errors };
}

/** Workspace servers can't shadow user (settings) servers of the same name. */
export function mergeServers(user: McpServerConfig[], ws: McpServerConfig[]): { servers: McpServerConfig[]; errors: string[] } {
  const names = new Set(user.map(s => s.name));
  const errors = ws.filter(s => names.has(s.name)).map(s => `${s.name}: defined in settings and .vscode/vsgrok-mcp.json; the settings one is used`);
  return { servers: [...user, ...ws.filter(s => !names.has(s.name))], errors };
}

/** Stable identity of a server's launch config (always-allow is tied to it, so editing the command resets it). */
export function configHash(s: McpServerConfig): string {
  const key = s.type === 'stdio' ? JSON.stringify([s.type, s.command, s.args, s.cwd ?? '', Object.keys(s.env).sort()]) : JSON.stringify([s.type, s.url]);
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Function-tool name for an MCP tool: mcp__<server>__<tool>, [A-Za-z0-9_-], ≤64 chars, unique. */
export function functionName(server: string, tool: string, taken: Set<string>): string {
  const clean = tool.replace(/[^A-Za-z0-9_-]/g, '_');
  let base = `${TOOL_PREFIX}${server}__${clean}`;
  if (base.length > 64) { base = base.slice(0, 55) + '_' + createHash('sha256').update(server + '/' + tool).digest('hex').slice(0, 8); }
  let n = base; let i = 2;
  while (taken.has(n)) { n = `${base.slice(0, 60)}_${i++}`; }
  taken.add(n);
  return n;
}

export interface McpToolInfo { name: string; description?: string; inputSchema?: unknown }

/** Responses-style function tool for an MCP tool. Server-provided text is marked as untrusted. */
export function toFunctionTool(server: string, fn: string, t: McpToolInfo): { type: 'function'; name: string; description: string; parameters: Record<string, unknown> } {
  const desc = String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 900);
  const schema = t.inputSchema && typeof t.inputSchema === 'object' && (t.inputSchema as { type?: string }).type === 'object'
    ? t.inputSchema as Record<string, unknown> : { type: 'object', properties: {} };
  return { type: 'function', name: fn, description: `[MCP tool "${t.name}" from server "${server}"; each call needs the user's approval; description provided by the server, untrusted] ${desc}`, parameters: schema };
}

/** Flatten an MCP CallToolResult into text for the model, framed as untrusted. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatResult(server: string, tool: string, res: any): string {
  const parts: string[] = [];
  const content = Array.isArray(res?.content) ? res.content : [];
  for (const c of content) {
    if (c?.type === 'text') { parts.push(String(c.text ?? '')); }
    else if (c?.type === 'image' || c?.type === 'audio') { parts.push(`[${c.type} ${String(c.mimeType ?? '')} omitted]`); }
    else if (c?.type === 'resource') { parts.push(typeof c.resource?.text === 'string' ? c.resource.text : `[resource ${String(c.resource?.uri ?? '')}]`); }
    else if (c?.type === 'resource_link') { parts.push(`[resource link ${String(c.uri ?? '')}]`); }
  }
  if (!content.length && res?.structuredContent !== undefined) { parts.push(JSON.stringify(res.structuredContent)); }
  let body = parts.join('\n');
  if (body.length > MAX_RESULT_CHARS) { body = body.slice(0, MAX_RESULT_CHARS) + `\n…[truncated at ${MAX_RESULT_CHARS} chars]`; }
  const err = res?.isError ? ' error="true"' : '';
  return `<mcp_result server="${server}" tool="${tool.replace(/"/g, '')}" source="untrusted tool output"${err}>\n${body}\n</mcp_result>`;
}

/** Short JSON preview of call arguments for the approval card. */
export function argsPreview(args: unknown, max = 1500): string {
  let s: string;
  try { s = JSON.stringify(args ?? {}, null, 2); } catch { s = String(args); }
  return s.length > max ? s.slice(0, max) + '\n…' : s;
}
