// Agent tools. Read-only tools run directly; edits go through diff+Accept; commands need explicit confirmation.
import * as vscode from 'vscode';
import { ToolSpec } from '../xai/client';
import { proposeEdit } from '../proposals';

const MAX_READ = 200_000;

export const TOOL_SPECS: ToolSpec[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List workspace files matching a glob (default **/*). Excludes node_modules.', parameters: { type: 'object', properties: { glob: { type: 'string' }, max: { type: 'number' } } } } },
  { type: 'function', function: { name: 'search_workspace', description: 'Search text (case-insensitive substring or regex) across workspace files. Returns path:line: text.', parameters: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' }, glob: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'propose_edit', description: 'Propose full new contents for a file (new or existing). The user sees a diff and must Accept; returns whether it was applied.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a shell command in the workspace root. The user must confirm first. Returns exit code and output.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
];

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
  if (!uri.path.startsWith(r.path)) { throw new Error(`Path escapes workspace: ${p}`); }
  return uri;
}

async function readText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  return text.length > MAX_READ ? text.slice(0, MAX_READ) + `\n…[truncated at ${MAX_READ} chars]` : text;
}

async function runCommand(command: string, token: vscode.CancellationToken): Promise<string> {
  const pick = await vscode.window.showWarningMessage(`Grok wants to run:\n${command}`, { modal: true }, 'Run');
  if (pick !== 'Run') { return 'User declined to run the command.'; }
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(name: string, args: any, token: vscode.CancellationToken): Promise<string> {
  try {
    switch (name) {
      case 'read_file': return await readText(resolveInWorkspace(String(args.path)));
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
        const r = await proposeEdit(resolveInWorkspace(String(args.path)), String(args.content), args.reason || 'Grok agent edit');
        return r.msg;
      }
      case 'run_command': return await runCommand(String(args.command), token);
      default: return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}
