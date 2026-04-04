// src/API.ts — Streaming-only xAI Grok API client with vision support

import * as vscode from 'vscode';
import * as https from 'https';

const API_BASE = 'https://api.x.ai/v1';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type MessageContent = string | (TextContentPart | ImageContentPart)[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export interface GrokRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// ── Error codes that mean "bad/missing key" ────────────────────────────────────

export type ApiErrorKind = 'auth' | 'rate_limit' | 'missing_key' | 'generic';

export class GrokApiError extends Error {
  public readonly kind: ApiErrorKind;
  public readonly statusCode?: number;

  constructor(message: string, kind: ApiErrorKind, statusCode?: number) {
    super(message);
    this.name = 'GrokApiError';
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

// ── Internals ──────────────────────────────────────────────────────────────────

async function getApiKey(context: vscode.ExtensionContext): Promise<string> {
  const apiKey = await context.secrets.get('vsgrok.apiKey');
  if (!apiKey) {
    throw new GrokApiError(
      'No xAI API key configured. Click "Set API Key" below to add one.',
      'missing_key'
    );
  }
  return apiKey;
}

function buildPayload(messages: ChatMessage[], options: GrokRequestOptions) {
  return {
    model: options.model || 'grok-4-0414',
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 4096,
    stream: true,
  };
}

function classifyHttpError(status: number, body: string): GrokApiError {
  if (status === 401 || status === 403) {
    return new GrokApiError(
      `Authentication failed (${status}). Your API key may be invalid or expired.`,
      'auth',
      status
    );
  }
  if (status === 429) {
    return new GrokApiError(
      `Rate limited (${status}). You've exceeded your xAI API quota. Please wait and try again.`,
      'rate_limit',
      status
    );
  }
  return new GrokApiError(
    `xAI API error (${status}): ${body || 'Unknown error'}`,
    'generic',
    status
  );
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Streaming call — invokes onChunk for each content delta, returns full assembled text */
export async function callGrokStream(
  context: vscode.ExtensionContext,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  options: GrokRequestOptions = {}
): Promise<string> {
  const apiKey = await getApiKey(context);
  const payload = buildPayload(messages, options);
  const body = JSON.stringify(payload);

  return new Promise<string>((resolve, reject) => {
    const url = new URL(`${API_BASE}/chat/completions`);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.on('data', (d: Buffer) => (errBody += d.toString()));
          res.on('end', () => {
            let msg = errBody;
            try {
              const parsed = JSON.parse(errBody);
              msg = parsed?.error?.message || errBody;
            } catch { /* use raw body */ }
            reject(classifyHttpError(res.statusCode!, msg));
          });
          return;
        }

        let fullText = '';
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
            const data = trimmed.slice(6);
            if (data === '[DONE]') { continue; }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                onChunk(delta);
              }
            } catch {
              // skip malformed SSE chunks
            }
          }
        });

        res.on('end', () => resolve(fullText));
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}