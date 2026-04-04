// src/extension.ts

import * as vscode from 'vscode';
import * as fs from 'fs';

import {
  callGrokStream,
  ChatMessage,
  GrokApiError,
  MessageContent,
  TextContentPart,
  ImageContentPart,
} from './API';

let extensionContext: vscode.ExtensionContext;
let statusBarItem: vscode.StatusBarItem;

const MAX_HISTORY = 20;

const SYSTEM_PROMPT: ChatMessage = {
  role: 'system',
  content:
    'You are Grok, a helpful and maximally truthful AI built by xAI. ' +
    'You are running inside the VSCode extension "VSGrok". ' +
    'You are a super coding agent whose task is assisting the user in their software development. ' +
    'Always format code blocks with the appropriate language tag. Be concise but thorough.',
};

function buildCommandPrompt(
  action: 'explain' | 'fix' | 'comment' | 'test',
  code: string,
  language: string
): string {
  const prompts: Record<string, string> = {
    explain: `Explain the following ${language} code clearly and concisely. Describe what it does, any edge cases, and potential improvements:\n\n\`\`\`${language}\n${code}\n\`\`\``,
    fix: `Fix any bugs, issues, or anti-patterns in the following ${language} code. Return the corrected code with a brief explanation of what was wrong:\n\n\`\`\`${language}\n${code}\n\`\`\``,
    comment: `Add clear, professional inline comments to the following ${language} code. Return the fully commented code:\n\n\`\`\`${language}\n${code}\n\`\`\``,
    test: `Write comprehensive unit tests for the following ${language} code. Use the most common testing framework for ${language}. Cover edge cases:\n\n\`\`\`${language}\n${code}\n\`\`\``,
  };
  return prompts[action];
}

/** Resolve @file and @workspace placeholders in user text */
function resolveContextTags(text: string): string {
  let result = text;

  // @file → inject active file content
  if (result.includes('@file')) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const doc = editor.document;
      const lang = doc.languageId;
      const relPath = vscode.workspace.asRelativePath(doc.uri);
      const content = doc.getText();
      const injection = `\n\n**[File: \`${relPath}\`]**\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
      result = result.replace(/@file/g, injection);
    } else {
      result = result.replace(/@file/g, '\n*(No file is currently open)*\n');
    }
  }

  // @workspace → inject folder structure + open editors summary
  if (result.includes('@workspace')) {
    const parts: string[] = [];
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      parts.push(`**Workspace:** \`${folder.name}\` (${folder.uri.fsPath})`);
    }
    const openDocs = vscode.workspace.textDocuments
      .filter(d => d.uri.scheme === 'file')
      .map(d => `- \`${vscode.workspace.asRelativePath(d.uri)}\` (${d.languageId}, ${d.lineCount} lines)`);
    if (openDocs.length) {
      parts.push('**Open files:**\n' + openDocs.join('\n'));
    }
    // Simple top-level listing if workspace folder exists
    if (folder) {
      try {
        const entries = fs.readdirSync(folder.uri.fsPath, { withFileTypes: true })
          .slice(0, 40)
          .map(e => `- ${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
        parts.push('**Root contents:**\n' + entries.join('\n'));
      } catch { /* ignore */ }
    }
    const injection = '\n\n' + (parts.length ? parts.join('\n\n') : '*(No workspace open)*') + '\n';
    result = result.replace(/@workspace/g, injection);
  }

  return result;
}

function showStatusBarBusy(text: string) {
  statusBarItem.text = `$(sync~spin) ${text}`;
  statusBarItem.tooltip = 'Grok is working…';
  statusBarItem.show();
}

function hideStatusBar() {
  statusBarItem.text = '$(hubot) VSGrok';
  statusBarItem.tooltip = 'VSGrok – Ready';
}

class GrokAgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'VSGrokView';

  private _view?: vscode.WebviewView;
  private _history: ChatMessage[] = [];
  private _lastUserText = '';

  // Settings pushed from webview (defaults)
  private _model = 'grok-4-0414';
  private _temperature = 0.7;
  private _maxTokens = 4096;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'query':
            await this._handleUserQuery(message.text, message.images);
            break;
          case 'clearChat':
            this._history = [];
            this._lastUserText = '';
            this._view?.webview.postMessage({ command: 'chatCleared' });
            break;
          case 'regenerate':
            if (this._lastUserText) {
              // Pop last assistant message if present
              if (this._history.length && this._history[this._history.length - 1].role === 'assistant') {
                this._history.pop();
              }
              // Pop last user message too — _handleUserQuery will re-add it
              if (this._history.length && this._history[this._history.length - 1].role === 'user') {
                this._history.pop();
              }
              await this._handleUserQuery(this._lastUserText);
            }
            break;
          case 'updateSettings':
            if (message.model) { this._model = message.model; }
            if (message.temperature !== undefined) { this._temperature = message.temperature; }
            if (message.maxTokens !== undefined) { this._maxTokens = message.maxTokens; }
            break;
          case 'setApiKey':
            await vscode.commands.executeCommand('vsgrok.setApiKey');
            break;
        }
      },
      undefined,
      extensionContext.subscriptions
    );
  }

  /** Called by context-menu commands to inject a query from outside */
  public async injectQuery(userText: string) {
    await vscode.commands.executeCommand('VSGrokView.focus');
    await new Promise((r) => setTimeout(r, 300));
    await this._handleUserQuery(userText);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'ux', 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

    // Resolve the local marked.min.js URI
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'ux', 'webview', 'marked.min.js')
    );
    html = html.replace('{{MARKED_URI}}', markedUri.toString());
    return html;
  }

  private _trimHistory() {
    // Keep at most MAX_HISTORY messages (user + assistant pairs)
    while (this._history.length > MAX_HISTORY) {
      this._history.shift();
    }
  }

  private async _handleUserQuery(userText: string, images?: string[]) {
    if (!this._view) { return; }

    // Resolve @file / @workspace
    const resolved = resolveContextTags(userText);

    // Build message content (with optional images for vision)
    let content: MessageContent;
    if (images && images.length > 0) {
      const parts: (TextContentPart | ImageContentPart)[] = [
        { type: 'text', text: resolved },
      ];
      for (const dataUrl of images) {
        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
      content = parts;
    } else {
      content = resolved;
    }

    this._history.push({ role: 'user', content });
    this._lastUserText = userText;
    this._trimHistory();

    // Show in webview (display only the raw user text, not the resolved version)
    this._view.webview.postMessage({ command: 'userMessage', content: userText });
    this._view.webview.postMessage({ command: 'loading', visible: true });
    showStatusBarBusy('Grok is thinking…');

    try {
      const messages: ChatMessage[] = [SYSTEM_PROMPT, ...this._history];

      this._view.webview.postMessage({ command: 'streamStart' });

      const fullReply = await callGrokStream(
        extensionContext,
        messages,
        (chunk) => {
          this._view?.webview.postMessage({ command: 'stream', chunk });
        },
        { model: this._model, temperature: this._temperature, maxTokens: this._maxTokens }
      );

      this._view.webview.postMessage({ command: 'streamEnd', content: fullReply });
      this._history.push({ role: 'assistant', content: fullReply });
      this._trimHistory();
    } catch (err: unknown) {
      const isApiError = err instanceof GrokApiError;
      const kind = isApiError ? (err as GrokApiError).kind : 'generic';
      const errorMsg = (err as Error).message || 'An unknown error occurred';

      this._view.webview.postMessage({
        command: 'error',
        content: errorMsg,
        kind,
      });
    } finally {
      this._view.webview.postMessage({ command: 'loading', visible: false });
      hideStatusBar();
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  // ── Status bar ──
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(hubot) VSGrok';
  statusBarItem.tooltip = 'VSGrok – Ready';
  statusBarItem.command = 'VSGrokView.focus';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── Webview provider ──
  const provider = new GrokAgentViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GrokAgentViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ── Set API Key ──
  context.subscriptions.push(
    vscode.commands.registerCommand('vsgrok.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your xAI API Key',
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey) {
        await context.secrets.store('vsgrok.apiKey', apiKey);
        vscode.window.showInformationMessage('✅ xAI API Key saved securely.');
      }
    })
  );

  // ── Command Palette: Ask Query ──
  context.subscriptions.push(
    vscode.commands.registerCommand('vsgrok.query', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'Ask Grok anything…',
        placeHolder: 'Type your question here',
        ignoreFocusOut: true,
      });
      if (query?.trim()) {
        await provider.injectQuery(query.trim());
      }
    })
  );

  // ── Context-menu code commands ──
  const registerCodeCommand = (
    commandId: string,
    action: 'explain' | 'fix' | 'comment' | 'test'
  ) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('No active editor.');
          return;
        }
        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText.trim()) {
          vscode.window.showWarningMessage('Please select some code first.');
          return;
        }
        const language = editor.document.languageId;
        const prompt = buildCommandPrompt(action, selectedText, language);
        await provider.injectQuery(prompt);
      })
    );
  };

  registerCodeCommand('vsgrok.explainCode', 'explain');
  registerCodeCommand('vsgrok.fixCode', 'fix');
  registerCodeCommand('vsgrok.addComments', 'comment');
  registerCodeCommand('vsgrok.writeTests', 'test');
}

export function deactivate() {
  statusBarItem?.dispose();
}