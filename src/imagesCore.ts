// Image input rules (pure). xAI image understanding accepts jpg/jpeg or png, up to 20 MiB each
// (https://docs.x.ai/developers/model-capabilities/images/understanding). The webview downscales before sending.
export const MAX_IMAGES = 8;
export const API_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** What the webview aims for after downscaling (long side px, bytes). */
export const TARGET_MAX_SIDE = 2048;
export const TARGET_MAX_BYTES = 4 * 1024 * 1024;
/** Enforced by the extension (the webview targets these too): per image and per message. */
export const MAX_IMAGE_BYTES = TARGET_MAX_BYTES;
export const MAX_MESSAGE_IMAGE_BYTES = 16 * 1024 * 1024;
/** Raw file read cap for dropped/picked images (the API limit; larger files would be downscaled anyway). */
export const MAX_IMAGE_FILE_BYTES = API_MAX_IMAGE_BYTES;
export const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

const PREFIX_RE = /^data:image\/(png|jpeg);base64,/;

/** Decoded size of a base64 string. */
export function decodedBytes(b64: string): number { const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0; return Math.floor(b64.length * 3 / 4) - pad; }

/** True if s[from..] is canonical base64 (no whitespace). Manual scan: no regex copy of a multi-MB capture. */
function isBase64Tail(s: string, from: number): boolean {
  const n = s.length - from;
  if (n <= 0 || n % 4 !== 0) { return false; }
  let pad = 0;
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) { pad++; if (pad > 2 || i < s.length - 2) { return false; } continue; } // '='
    if (pad) { return false; }
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
    if (!ok) { return false; }
  }
  return true;
}

/** Validate one data URL from the webview: PNG/JPEG base64 only, magic bytes match, at most MAX_IMAGE_BYTES decoded. */
export function checkImageDataUrl(s: unknown, maxBytes = MAX_IMAGE_BYTES): { ok: true; mime: 'image/png' | 'image/jpeg'; bytes: number } | { ok: false; reason: string } {
  if (typeof s !== 'string') { return { ok: false, reason: 'not a string' }; }
  const limitMiB = Math.round(maxBytes / 1048576);
  if (s.length > maxBytes * 1.34 + 64) { return { ok: false, reason: `image larger than ${limitMiB} MiB` }; }
  const m = PREFIX_RE.exec(s);
  if (!m || !isBase64Tail(s, m[0].length)) { return { ok: false, reason: 'only PNG or JPEG data URLs are accepted' }; }
  const tail = s.length - m[0].length;
  const bytes = Math.floor(tail * 3 / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
  if (bytes > maxBytes) { return { ok: false, reason: `image larger than ${limitMiB} MiB` }; }
  const head = Buffer.from(s.slice(m[0].length, m[0].length + 16), 'base64');
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (m[1] === 'png' ? !png : !jpg) { return { ok: false, reason: 'image data does not match its type' }; }
  return { ok: true, mime: m[1] === 'png' ? 'image/png' : 'image/jpeg', bytes };
}

/** Keep valid images up to MAX_IMAGES and MAX_MESSAGE_IMAGE_BYTES in total; report what was dropped. */
export function filterImages(list: unknown): { images: string[]; dropped: string[]; kept: number[] } {
  const images: string[] = []; const dropped: string[] = []; const kept: number[] = [];
  const arr = Array.isArray(list) ? list : [];
  let total = 0;
  for (const [i, s] of arr.slice(0, MAX_IMAGES * 2).entries()) {
    if (images.length >= MAX_IMAGES) { dropped.push(`image ${i + 1}: more than ${MAX_IMAGES} images`); continue; } // L1: count first, no scan
    const c = checkImageDataUrl(s);
    if (!c.ok) { dropped.push(`image ${i + 1}: ${c.reason}`); continue; }
    if (total + c.bytes > MAX_MESSAGE_IMAGE_BYTES) { dropped.push(`image ${i + 1}: over ${MAX_MESSAGE_IMAGE_BYTES / 1048576} MiB of images in one message`); continue; }
    total += c.bytes; images.push(s as string); kept.push(i);
  }
  if (arr.length > MAX_IMAGES * 2) { dropped.push(`${arr.length - MAX_IMAGES * 2} more images ignored`); }
  return { images, dropped, kept };
}

/** Sniff an image file's real type from its first bytes (M3). */
export function sniffImage(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp' | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { return 'image/png'; }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { return 'image/jpeg'; }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) { return 'image/gif'; }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) { return 'image/webp'; }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) { return 'image/bmp'; }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;
/**
 * H1/M2: replace input_image parts in all but the last `keepTurns` user messages that carry images with a short
 * text placeholder, so old images aren't resent (and re-billed) on every turn or sent to compaction. Returns a new array.
 */
export function stripOldImages(items: Item[], keepTurns = 1): { items: Item[]; stripped: number } {
  const withImg: number[] = [];
  items.forEach((it, i) => { if (it?.role === 'user' && Array.isArray(it.content) && it.content.some((c: Item) => c?.type === 'input_image')) { withImg.push(i); } });
  const strip = new Set(withImg.slice(0, Math.max(0, withImg.length - keepTurns)));
  let stripped = 0;
  const out = items.map((it, i) => {
    if (!strip.has(i)) { return it; }
    let n = 0;
    const content = it.content.map((c: Item) => { if (c?.type !== 'input_image') { return c; } n++; return { type: 'input_text', text: `[image ${n} from an earlier message omitted]` }; });
    stripped += n;
    return { ...it, content };
  });
  return { items: out, stripped };
}

/** M1: reasoning items created under store=true have no encrypted_content and can't be resent statelessly. */
export function dropUnresolvableReasoning(items: Item[]): { items: Item[]; dropped: number } {
  const out = items.filter(it => !(it?.type === 'reasoning' && !it.encrypted_content));
  return { items: out, dropped: items.length - out.length };
}

/** Vision gate: false = known not to accept images; true/undefined = allow (unknown models are tried). */
export function visionBlocked(model: string, models: { id: string; vision?: boolean; aliases?: string[] }[]): { blocked: boolean; suggest?: string } {
  const m = models.find(x => x.id === model) ?? models.find(x => x.aliases?.includes(model));
  if (m?.vision !== false) { return { blocked: false }; }
  const alt = models.find(x => x.vision === true);
  return { blocked: true, suggest: alt?.id };
}
