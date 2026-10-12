// Guards for anything that reads workspace files on Grok's behalf (attachments, tools, index, inline completions).
import * as vscode from 'vscode';
import { isSecretPath, isInside } from './index/lexical';

export const ALLOWED_SCHEMES = new Set(['file', 'vscode-remote', 'untitled']);

export interface FileCheck { ok: boolean; reason?: string; rel: string }

/** Path relative to its workspace folder (POSIX), or undefined if outside every folder. */
export function relInWorkspace(uri: vscode.Uri): string | undefined {
  const f = vscode.workspace.getWorkspaceFolder(uri);
  if (!f) { return undefined; }
  const base = f.uri.path.replace(/\/+$/, '');
  return uri.path === base ? '' : uri.path.startsWith(base + '/') ? uri.path.slice(base.length + 1) : undefined;
}

/** For file: URIs, resolve symlinks and require the real path to stay inside the workspace folder. */
async function realInside(uri: vscode.Uri): Promise<boolean> {
  if (uri.scheme !== 'file') { return true; }
  const f = vscode.workspace.getWorkspaceFolder(uri);
  if (!f) { return false; }
  const fs = await import('fs');
  const path = await import('path');
  try {
    const [root, real] = await Promise.all([fs.promises.realpath(f.uri.fsPath), fs.promises.realpath(uri.fsPath)]);
    if (!isInside(root, real, path.sep)) { return false; }
    // A symlink inside the workspace pointing at a secret-looking name elsewhere in the workspace is caught too.
    return !isSecretPath(path.relative(root, real).split(path.sep).join('/'));
  } catch { return true; } // nonexistent (e.g. new file) — the caller's own read will fail
}

/**
 * May VSGrok read this file and send it to xAI? Only workspace files (file / vscode-remote), never secret-looking
 * paths, never symlinks that resolve outside the workspace or onto a secret.
 */
export async function checkReadable(uri: vscode.Uri): Promise<FileCheck> {
  const rel0 = vscode.workspace.asRelativePath(uri, false);
  if (uri.scheme === 'untitled') { return { ok: true, rel: rel0 }; }
  if (!ALLOWED_SCHEMES.has(uri.scheme)) { return { ok: false, rel: rel0, reason: `unsupported location (${uri.scheme}:)` }; }
  const rel = relInWorkspace(uri);
  if (rel === undefined) { return { ok: false, rel: rel0, reason: 'outside the open workspace' }; }
  if (isSecretPath(rel)) { return { ok: false, rel, reason: 'looks like a secrets/credentials file' }; }
  if (!(await realInside(uri))) { return { ok: false, rel, reason: 'symlink to a file outside the workspace or to a secret' }; }
  return { ok: true, rel };
}

/** Sync variant for hot paths (diagnostics): real path inside the workspace and not a secret. Nonexistent → false. */
export function realInsideSync(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') { return true; }
  const f = vscode.workspace.getWorkspaceFolder(uri);
  if (!f) { return false; }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs'); const path = require('path') as typeof import('path');
  try {
    const root = fs.realpathSync(f.uri.fsPath), real = fs.realpathSync(uri.fsPath);
    return isInside(root, real, path.sep) && !isSecretPath(path.relative(root, real).split(path.sep).join('/'));
  } catch { return false; }
}

/**
 * May VSGrok create/overwrite/rename-onto this path? Same rules as checkReadable, plus: the nearest existing ancestor
 * (and the target itself, if it exists) must resolve inside the workspace, and the resolved target must not look secret.
 */
export async function checkWritable(uri: vscode.Uri): Promise<FileCheck> {
  const rel0 = vscode.workspace.asRelativePath(uri, false);
  if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') { return { ok: false, rel: rel0, reason: `unsupported location (${uri.scheme}:)` }; }
  const rel = relInWorkspace(uri);
  if (rel === undefined || rel === '') { return { ok: false, rel: rel0, reason: 'outside the open workspace' }; }
  if (isSecretPath(rel)) { return { ok: false, rel, reason: 'looks like a secrets/credentials file' }; }
  if (uri.scheme !== 'file') { return { ok: true, rel }; }
  const f = vscode.workspace.getWorkspaceFolder(uri)!;
  const fs = await import('fs'); const path = await import('path');
  let root: string;
  try { root = await fs.promises.realpath(f.uri.fsPath); } catch { return { ok: false, rel, reason: 'workspace folder not resolvable' }; }
  let probe = uri.fsPath; const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.promises.realpath(probe);
      const resolved = tail.length ? path.join(real, ...tail.reverse()) : real;
      if (!isInside(root, resolved, path.sep)) { return { ok: false, rel, reason: 'path resolves outside the workspace (symlink)' }; }
      if (isSecretPath(path.relative(root, resolved).split(path.sep).join('/'))) { return { ok: false, rel, reason: 'resolves to a secrets/credentials file (symlink)' }; }
      return { ok: true, rel };
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) { return { ok: false, rel, reason: 'no existing parent directory' }; }
      tail.push(path.basename(probe)); probe = parent;
    }
  }
}
