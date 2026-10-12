// Agent tools. Read-only tools run directly; edits and commands need Approve on an in-chat card.
import * as vscode from 'vscode';
import { ToolSpec } from '../xai/client';
import { FunctionTool } from '../xai/responses';
import { proposeEdit } from '../proposals';
import { requestApproval } from './approvals';
import { isSecretPath } from '../index/lexical';
import { diag } from '../diagnostics';
import { checkReadable } from '../security';
import { workspaceIndex } from '../index/workspaceIndex';

function toSignal(token: vscode.CancellationToken): AbortSignal {
  const ac = new AbortController();
  if (token.isCancellationRequested) { ac.abort(); } else { token.onCancellationRequested(() => ac.abort()); }
  return ac.signal;
}

/** ~1M chars ≈ 250k tokens: half of grok-4.7's 500k context (docs.x.ai/developers/models). */
const MAX_READ = 1_000_000;

/** Read-only tools: always offered in chat. */
export const READ_TOOL_SPECS: ToolSpec[] = [
  { type: 'function', function: { name: 'find_relevant_files', description: 'Find the files most relevant to a task or question using the local workspace index (BM25 over file paths, symbol names and contents). Returns ranked paths with matching lines and symbol outlines. Use this first for "where is X handled", "how does Y work" or before editing an unfamiliar area, then read_file the top hits.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Natural-language or identifier query' }, max: { type: 'number', description: 'Max files (default 10, max 30)' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'get_workspace_overview', description: 'Overview of the open VS Code workspace: folder name(s), top-level tree, package.json / README summary, open editors, active file, git branch and status. Call this first when asked about "the workspace" or "this project".', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List workspace files matching a glob (default **/*). Excludes node_modules.', parameters: { type: 'object', properties: { glob: { type: 'string' }, max: { type: 'number' } } } } },
  { type: 'function', function: { name: 'search_workspace', description: 'Search text (case-insensitive substring or regex) across workspace files. Returns path:line: text.', parameters: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' }, glob: { type: 'string' } }, required: ['query'] } } },
];

/** Write tools: offered only when Agent is on; each still needs the user's Accept/confirm. */
export const WRITE_TOOL_SPECS: ToolSpec[] = [
  { type: 'function', function: { name: 'propose_edit', description: 'Propose full new contents for a file (new or existing). The user sees a diff and must Accept; returns whether it was applied.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a shell command in the workspace root. The user must confirm first. Returns exit code and output.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
];

export const TOOL_SPECS: ToolSpec[] = [...READ_TOOL_SPECS, ...WRITE_TOOL_SPECS];
/** Chat Completions tool spec → Responses function tool ({type,name,description,parameters}). */
export function toResponsesTools(specs: ToolSpec[]): FunctionTool[] {
  return specs.map(t => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
}

export const READ_ONLY_TOOL_NAMES = new Set(READ_TOOL_SPECS.map(t => t.function.name));

const EXCLUDE = '**/{node_modules,.git,dist,out}/**';

function root(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) { throw new Error('No workspace folder open.'); }
  return f.uri;
}

export function resolveInWorkspace(p: string): vscode.Uri {
  const r = root();
  const clean = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  const uri = vscode.Uri.joinPath(r, clean);
  if (uri.path !== r.path && !uri.path.startsWith(r.path.replace(/\/+$/, '') + '/')) { throw new Error(`Path escapes workspace: ${p}`); }
  return uri;
}

async function readText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  return text.length > MAX_READ ? text.slice(0, MAX_READ) + `\n…[truncated at ${MAX_READ} chars]` : text;
}

async function runCommand(command: string, token: vscode.CancellationToken): Promise<string> {
  const ok = await requestApproval({ kind: 'command', command }, { signal: toSignal(token) });
  if (!ok) { return 'User declined to run the command.'; }
  const cp = await import('child_process');
  return new Promise((resolve) => {
    const child = cp.spawn(command, { cwd: root().fsPath, shell: true });
    let out = '';
    const add = (d: Buffer) => { out += d.toString(); if (out.length > 50_000) { out = out.slice(-50_000); } };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const sub = token.onCancellationRequested(() => child.kill());
    const t = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code) => { clearTimeout(t); sub.dispose(); resolve(`exit code ${code}\n${out}`); });
    child.on('error', (e) => { clearTimeout(t); sub.dispose(); resolve(`failed: ${e.message}`); });
  });
}

function git(args: string[], cwd: string): Promise<string> {
  return import('child_process').then(cp => new Promise<string>((resolve) => {
    cp.execFile('git', args, { cwd, timeout: 5000, maxBuffer: 1_000_000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  }));
}

async function workspaceOverview(token: vscode.CancellationToken): Promise<string> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) { return 'No workspace folder is open in VS Code. Ask the user to open a folder (File → Open Folder).'; }
  const out: string[] = [];
  out.push(`Workspace: ${vscode.workspace.name ?? folders[0].name}`);
  out.push('Folders: ' + folders.map(f => `${f.name} (${f.uri.scheme === 'file' ? f.uri.fsPath : f.uri.toString()})`).join(', '));
  const r = folders[0].uri;
  try {
    const entries = (await vscode.workspace.fs.readDirectory(r))
      .filter(([n]) => !['.git', 'node_modules'].includes(n))
      .sort((a, b) => (b[1] & vscode.FileType.Directory) - (a[1] & vscode.FileType.Directory) || a[0].localeCompare(b[0]))
      .slice(0, 80);
    out.push('\nTop level:\n' + entries.map(([n, t]) => `- ${n}${t & vscode.FileType.Directory ? '/' : ''}`).join('\n'));
  } catch (e) { out.push(`(could not list root: ${(e as Error).message})`); }
  try {
    const pkg = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(r, 'package.json'))).toString('utf8'));
    const scripts = pkg.scripts ? Object.keys(pkg.scripts).join(', ') : '';
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).slice(0, 30).join(', ');
    out.push(`\npackage.json: ${pkg.name ?? '?'}@${pkg.version ?? '?'} — ${pkg.description ?? ''}\nscripts: ${scripts}\ndeps: ${deps}`);
  } catch { /* none */ }
  for (const name of ['README.md', 'readme.md', 'README']) {
    try {
      const t = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(r, name))).toString('utf8');
      out.push(`\n${name} (first 1500 chars):\n${t.slice(0, 1500)}`);
      break;
    } catch { /* try next */ }
  }
  if (token.isCancellationRequested) { return out.join('\n'); }
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
    .map(t => (t.input as { uri?: vscode.Uri } | undefined)?.uri)
    .filter((u): u is vscode.Uri => !!u)
    .map(u => vscode.workspace.asRelativePath(u));
  out.push('\nOpen editors: ' + (tabs.length ? [...new Set(tabs)].slice(0, 40).join(', ') : '(none)'));
  const ed = vscode.window.activeTextEditor;
  if (ed) { out.push(`Active file: ${vscode.workspace.asRelativePath(ed.document.uri)} (line ${ed.selection.active.line + 1})`); }
  if (r.scheme === 'file') {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], r.fsPath);
    if (branch) {
      const status = await git(['status', '--short'], r.fsPath);
      const lines = status ? status.split('\n') : [];
      out.push(`\nGit branch: ${branch}\nGit status: ${lines.length ? lines.slice(0, 50).join('\n') + (lines.length > 50 ? `\n…(+${lines.length - 50} more)` : '') : 'clean'}`);
    } else { out.push('\nGit: not a git repository (or git not available).'); }
  }
  return out.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(name: string, args: any, token: vscode.CancellationToken): Promise<string> {
  const t0 = Date.now();
  try { return await executeToolInner(name, args, token); } finally { diag('tool', { name, ms: Date.now() - t0 }); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeToolInner(name: string, args: any, token: vscode.CancellationToken): Promise<string> {
  try {
    switch (name) {
      case 'get_workspace_overview': return await workspaceOverview(token);
      case 'find_relevant_files': return await workspaceIndex.findRelevant(String(args.query ?? ''), Number(args.max) || 10, token);
      case 'read_file': {
        if (isSecretPath(String(args.path))) { return `Refused: ${args.path} looks like a secrets/credentials file (.env, keys, tokens). VSGrok never reads these.`; }
        const u = resolveInWorkspace(String(args.path));
        const chk = await checkReadable(u);
        if (!chk.ok) { return `Refused: ${args.path} (${chk.reason}). VSGrok never reads these.`; }
        return await readText(u);
      }
      case 'list_files': {
        const files = await vscode.workspace.findFiles(args.glob || '**/*', EXCLUDE, Math.min(Number(args.max) || 300, 2000), token);
        return files.map(f => vscode.workspace.asRelativePath(f)).sort().join('\n') || '(no files)';
      }
      case 'search_workspace': {
        const files = await vscode.workspace.findFiles(args.glob || '**/*', EXCLUDE, 2000, token);
        const re = args.regex ? new RegExp(String(args.query), 'i') : null;
        const q = String(args.query).toLowerCase();
        const hits: string[] = [];
        for (const f of files) {
          if (token.isCancellationRequested || hits.length >= 200) { break; }
          if (isSecretPath(vscode.workspace.asRelativePath(f, false)) || !(await checkReadable(f)).ok) { continue; }
          let text: string;
          try { const b = await vscode.workspace.fs.readFile(f); if (b.length > 1_000_000 || b.includes(0)) { continue; } text = Buffer.from(b).toString('utf8'); } catch { continue; }
          text.split('\n').forEach((line, i) => {
            if (hits.length < 200 && (re ? re.test(line) : line.toLowerCase().includes(q))) {
              hits.push(`${vscode.workspace.asRelativePath(f)}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        }
        return hits.join('\n') || '(no matches)';
      }
      case 'propose_edit': {
        const r = await proposeEdit(resolveInWorkspace(String(args.path)), String(args.content), args.reason || 'Grok agent edit', toSignal(token));
        return r.msg;
      }
      case 'run_command': return await runCommand(String(args.command), token);
      default: return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}
