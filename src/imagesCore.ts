// Image input rules (pure). xAI image understanding accepts jpg/jpeg or png, up to 20 MiB each
// (https://docs.x.ai/developers/model-capabilities/images/understanding). The webview downscales before sending.
export const MAX_IMAGES = 8;
export const API_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** What the webview aims for after downscaling (long side px, bytes). */
export const TARGET_MAX_SIDE = 2048;
export const TARGET_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

const DATA_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

export function decodedBytes(b64: string): number { const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0; return Math.floor(b64.length * 3 / 4) - pad; }

/** Validate one data URL from the webview: PNG/JPEG base64 only, magic bytes match, size under the API limit. */
export function checkImageDataUrl(s: unknown): { ok: true; mime: 'image/png' | 'image/jpeg'; bytes: number } | { ok: false; reason: string } {
  if (typeof s !== 'string') { return { ok: false, reason: 'not a string' }; }
  if (s.length > API_MAX_IMAGE_BYTES * 1.4) { return { ok: false, reason: 'image larger than 20 MiB' }; }
  const m = DATA_RE.exec(s);
  if (!m) { return { ok: false, reason: 'only PNG or JPEG data URLs are accepted' }; }
  const bytes = decodedBytes(m[2]);
  if (bytes > API_MAX_IMAGE_BYTES) { return { ok: false, reason: 'image larger than 20 MiB' }; }
  const head = Buffer.from(m[2].slice(0, 16), 'base64');
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (m[1] === 'png' ? !png : !jpg) { return { ok: false, reason: 'image data does not match its type' }; }
  return { ok: true, mime: m[1] === 'png' ? 'image/png' : 'image/jpeg', bytes };
}

/** Keep valid images up to MAX_IMAGES; report what was dropped. */
export function filterImages(list: unknown): { images: string[]; dropped: string[] } {
  const images: string[] = []; const dropped: string[] = [];
  for (const [i, s] of (Array.isArray(list) ? list : []).entries()) {
    const c = checkImageDataUrl(s);
    if (!c.ok) { dropped.push(`image ${i + 1}: ${c.reason}`); continue; }
    if (images.length >= MAX_IMAGES) { dropped.push(`image ${i + 1}: more than ${MAX_IMAGES} images`); continue; }
    images.push(s as string);
  }
  return { images, dropped };
}

/** Vision gate: false = known not to accept images; true/undefined = allow (unknown models are tried). */
export function visionBlocked(model: string, models: { id: string; vision?: boolean }[]): { blocked: boolean; suggest?: string } {
  const m = models.find(x => x.id === model);
  if (m?.vision !== false) { return { blocked: false }; }
  const alt = models.find(x => x.vision === true);
  return { blocked: true, suggest: alt?.id };
}
