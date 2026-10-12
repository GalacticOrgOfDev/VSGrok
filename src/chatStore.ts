// Local chat history under globalStorageUri/chats: one JSON file per chat plus index.json. Never stores the API key;
// every string is redacted and images are dropped (historyCore.prepareRecord).
import * as vscode from 'vscode';
import { ChatIndexEntry, ChatRecord, indexEntry, MAX_CHATS, prepareRecord, searchIndex } from './historyCore';

const ID_RE = /^c[a-z0-9-]{4,40}$/;

export class ChatStore {
  private index?: ChatIndexEntry[];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly base: vscode.Uri) {}

  private get dir() { return vscode.Uri.joinPath(this.base, 'chats'); }
  private file(id: string) { if (!ID_RE.test(id)) { throw new Error('bad chat id'); } return vscode.Uri.joinPath(this.dir, `${id}.json`); }

  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.queue.then(fn, fn); this.queue = p.catch(() => undefined); return p; }

  private async loadIndex(): Promise<ChatIndexEntry[]> {
    if (this.index) { return this.index; }
    try {
      const j = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir, 'index.json'))).toString('utf8'));
      this.index = Array.isArray(j) ? j.filter((e: ChatIndexEntry) => e && typeof e.id === 'string' && ID_RE.test(e.id)) : [];
    } catch { this.index = []; }
    return this.index!;
  }
  private async saveIndex() { await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.dir, 'index.json'), Buffer.from(JSON.stringify(this.index ?? []))); }

  save(r: ChatRecord): Promise<{ droppedConv: boolean }> {
    return this.serial(async () => {
      if (!r.messages.length) { return { droppedConv: false }; }
      await vscode.workspace.fs.createDirectory(this.dir);
      const p = prepareRecord(r);
      await vscode.workspace.fs.writeFile(this.file(r.id), Buffer.from(p.json, 'utf8'));
      const idx = await this.loadIndex();
      const e = indexEntry(p.record);
      const i = idx.findIndex(x => x.id === r.id);
      if (i >= 0) { idx[i] = e; } else { idx.push(e); }
      // Oldest chats beyond the cap are removed.
      idx.sort((a, b) => b.updated - a.updated);
      for (const old of idx.splice(MAX_CHATS)) { try { await vscode.workspace.fs.delete(this.file(old.id)); } catch { /* gone */ } }
      await this.saveIndex();
      return { droppedConv: p.droppedConv };
    });
  }

  async load(id: string): Promise<ChatRecord | undefined> {
    await this.queue;
    try {
      const r = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.file(id))).toString('utf8')) as ChatRecord;
      return r && r.v === 1 && r.id === id && Array.isArray(r.messages) ? r : undefined;
    } catch { return undefined; }
  }

  async list(query = ''): Promise<ChatIndexEntry[]> { await this.queue; return searchIndex(await this.loadIndex(), query); }

  rename(id: string, title: string): Promise<boolean> {
    return this.serial(async () => {
      const r = await this.loadRaw(id); if (!r) { return false; }
      r.title = title.trim().slice(0, 120) || r.title; r.titled = true;
      await vscode.workspace.fs.writeFile(this.file(id), Buffer.from(JSON.stringify(r), 'utf8'));
      const idx = await this.loadIndex(); const e = idx.find(x => x.id === id); if (e) { e.title = r.title; }
      await this.saveIndex();
      return true;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.serial(async () => {
      const idx = await this.loadIndex();
      const i = idx.findIndex(x => x.id === id);
      try { await vscode.workspace.fs.delete(this.file(id)); } catch { /* already gone */ }
      if (i >= 0) { idx.splice(i, 1); await this.saveIndex(); return true; }
      return false;
    });
  }

  private async loadRaw(id: string): Promise<ChatRecord | undefined> {
    try { return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.file(id))).toString('utf8')); } catch { return undefined; }
  }
}

export function newChatId(): string { return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
