// get_problems / run_tests tools and Problems context.
import * as vscode from 'vscode';
import { Problem, Sev, filterProblems, formatProblems, detectTestCommand, ProjectFiles, parseTestFailures, formatFailures, TestCommand, wrapProblems } from './checksCore';
import { isSecretPath } from '../index/lexical';
import { realInsideSync } from '../security';
import { redact } from '../diagLog';

const SEV: Record<number, Sev> = { 0: 'error', 1: 'warning', 2: 'info', 3: 'hint' };

export function collectProblems(uris?: vscode.Uri[]): Problem[] {
  const pairs: [vscode.Uri, readonly vscode.Diagnostic[]][] = uris ? uris.map(u => [u, vscode.languages.getDiagnostics(u)]) : vscode.languages.getDiagnostics();
  const out: Problem[] = [];
  for (const [u, ds] of pairs) {
    if (!vscode.workspace.getWorkspaceFolder(u)) { continue; }
    const rel = vscode.workspace.asRelativePath(u, false);
    if (isSecretPath(rel) || !realInsideSync(u)) { continue; } // L5: symlinks onto secrets/outside
    for (const d of ds) {
      out.push({ path: rel, line: d.range.start.line + 1, col: d.range.start.character + 1, severity: SEV[d.severity] ?? 'info', message: redact(d.message), source: d.source,
        code: d.code === undefined ? undefined : String(typeof d.code === 'object' ? d.code.value : d.code) });
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getProblemsTool(args: any): string {
  const sev = ['error', 'warning', 'info', 'hint'].includes(args?.severity) ? args.severity as Sev : 'warning';
  const { items, total } = filterProblems(collectProblems(), { minSeverity: sev, path: typeof args?.path === 'string' ? args.path : undefined, max: Number(args?.max) || 100 });
  return wrapProblems(formatProblems(items, total), 20000);
}

/** Problems for specific files, for the automatic context block (errors+warnings, capped). */
export function problemsContext(uris: vscode.Uri[], max = 50): { text: string; count: number } {
  const uniq = [...new Map(uris.map(u => [u.toString(), u])).values()];
  const { items, total } = filterProblems(collectProblems(uniq), { minSeverity: 'warning', max });
  return { text: total ? wrapProblems(formatProblems(items, total)) : '', count: total };
}


export async function detectProjectTests(): Promise<TestCommand | undefined> {
  const r = vscode.workspace.workspaceFolders?.[0]?.uri; if (!r) { return undefined; }
  const read = async (p: string) => { try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(r, p))).toString('utf8'); } catch { return undefined; } };
  const has = async (p: string) => { try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(r, p)); return true; } catch { return false; } };
  const f: ProjectFiles = {
    packageJson: await read('package.json'), hasPytestIni: await has('pytest.ini'), hasPyproject: await read('pyproject.toml'),
    hasSetupCfg: /\[tool:pytest\]/.test((await read('setup.cfg')) ?? ''), hasTestsDir: await has('tests'),
    hasGoMod: await has('go.mod'), hasCargo: await has('Cargo.toml'),
    lockfile: await has('pnpm-lock.yaml') ? 'pnpm' : await has('yarn.lock') ? 'yarn' : await has('bun.lockb') ? 'bun' : await has('package-lock.json') ? 'npm' : undefined,
  };
  // H4: a repo's .vscode/settings.json can set vsgrok.testCommand (Restricted Mode ignores it); label where it came from.
  const ins = vscode.workspace.getConfiguration('vsgrok').inspect<string>('testCommand');
  const ws = ins?.workspaceFolderValue ?? ins?.workspaceValue;
  if (typeof ws === 'string' && ws.trim()) { return detectTestCommand(f, ws, 'workspace'); }
  return detectTestCommand(f, ins?.globalValue ?? '', 'user');
}

export type CommandRunner = (cmd: string, token: vscode.CancellationToken, card?: { runs?: string[]; source?: string; repoControlled?: boolean }) => Promise<string>;
export async function runTestsTool(runCommand: CommandRunner, token: vscode.CancellationToken): Promise<string> {
  const tc = await detectProjectTests();
  if (!tc) { return 'Could not detect a test command (no package.json test script, pytest config, go.mod or Cargo.toml). Ask the user to set vsgrok.testCommand.'; }
  const out = await runCommand(tc.command, token, { runs: tc.runs, source: tc.source, repoControlled: tc.repoControlled });
  if (/^User declined/.test(out)) { return out; }
  const code = out.match(/^exit code (\S+)/)?.[1];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const fails = parseTestFailures(out, root);
  const tail = out.length > 6000 ? '…' + out.slice(-6000) : out;
  return `Ran \`${tc.command}\` (${tc.framework}, from ${tc.source}): exit code ${code ?? '?'}.\n${code === '0' ? 'All tests passed.' : formatFailures(fails)}\n\nOutput (tail):\n${tail}`;
}
