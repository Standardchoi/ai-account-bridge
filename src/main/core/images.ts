import type { ToolId } from './auth-bundle.js';
import type { IrImage } from './ir.js';
import type { PreparedMessage } from './render.js';

// 대상 도구가 받지 못하는 이미지 자리에 남기는 표시.
export const IMAGE_MARK = '[이미지]';

// 이관한 이미지는 이어서 대화할 때마다 요청에 다시 실린다 — 최근 것만 옮겨 문맥을 아끼고, Claude API 의
// "한 요청에 20장 초과" 규칙에 처음부터 걸리지 않게 한다.
export const MAX_IMAGES_PER_SESSION = 20;
// Claude API 의 이미지당 5MB 제한. base64 문자열 길이로 재서 실제 바이트보다 엄격하게 본다.
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;
// 옮기는 이미지의 합계(base64). Claude API 는 요청 전체가 32MB 를 넘으면 거부하는데 이관한 이미지는 매 요청에 다시 실린다 —
// 큰 이미지 20장(최대 100MB)이 한꺼번에 들어가 이어서 대화할 수 없게 되는 일을 막고, 글과 나중에 붙일 이미지 몫을 남긴다.
export const MAX_IMAGES_BASE64_TOTAL = 20 * 1024 * 1024;
// Claude API 는 한 요청에 이미지가 20장을 넘으면 한 변 2000px 까지만 받는다(그 이하 장수면 8000px).
// 옮긴 뒤 사용자가 이미지를 더 붙여도 대화가 깨지지 않게 Claude 로는 2000px 이하만 옮긴다.
// OpenAI(Codex)는 큰 이미지를 서버에서 줄이므로 가로세로 제한이 없다.
const MAX_EDGE: Record<ToolId, number> = { claude: 2000, codex: Number.POSITIVE_INFINITY };

export function parseDataUrl(url: string): IrImage | undefined {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? { mediaType: m[1]!.toLowerCase(), data: m[2]! } : undefined;
}

export const toDataUrl = (img: IrImage): string => `data:${img.mediaType};base64,${img.data}`;

export const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export interface ImageInfo { mediaType: string; width?: number; height?: number }

// 실제 바이트로 형식과 크기(px)를 판별한다 — 두 도구가 모두 받는 PNG·JPEG·GIF·WebP 만 인식하고, 그 밖은 undefined.
export function imageInfo(data: string): ImageInfo | undefined {
  const b = Buffer.from(data, 'base64');
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mediaType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mediaType: 'image/jpeg', ...jpegSize(b) };
  const head = b.toString('latin1', 0, 6);
  if (b.length >= 10 && (head === 'GIF87a' || head === 'GIF89a')) {
    return { mediaType: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return { mediaType: 'image/webp', ...webpSize(b) };
  }
  return undefined;
}

// JPEG 는 세그먼트를 따라가며 SOF(프레임 머리) 에서 크기를 읽는다.
function jpegSize(b: Buffer): { width?: number; height?: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return {};
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; } // 채움 바이트
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // 길이 없는 표지
    if (marker === 0xd9 || marker === 0xda) return {}; // SOF 없이 끝/본문 시작
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return {};
}

function webpSize(b: Buffer): { width?: number; height?: number } {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return {};
}

function acceptImage(img: IrImage, target: ToolId): IrImage | undefined {
  if (img.data.length > MAX_IMAGE_BASE64) return undefined;
  const info = imageInfo(img.data);
  if (!info) return undefined;
  const limit = MAX_EDGE[target];
  if (Number.isFinite(limit) && !(info.width && info.height && Math.max(info.width, info.height) <= limit)) return undefined;
  // 원본이 밝힌 형식이 실제와 다르면 실제 형식으로 쓴다(Claude API 는 불일치를 거부한다).
  return { mediaType: info.mediaType, data: img.data };
}

// 대상 도구에 옮길 이미지만 남긴다: 형식·용량·가로세로 제한을 통과한 것 중 대화 끝에서부터 최근 20장, 합계 20MB 까지.
// 옮기지 못한 이미지는 그 메시지 글 뒤에 [이미지] 표시로 남긴다. 입력 배열은 바꾸지 않는다.
export function applyImagePolicy(messages: PreparedMessage[], target: ToolId): PreparedMessage[] {
  let kept = 0;
  let total = 0;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (!m.images?.length) continue;
    const keep: IrImage[] = [];
    let dropped = 0;
    for (let k = m.images.length - 1; k >= 0; k--) {
      const img = m.images[k]!;
      const fits = kept < MAX_IMAGES_PER_SESSION && total + img.data.length <= MAX_IMAGES_BASE64_TOTAL;
      const ok = fits ? acceptImage(img, target) : undefined;
      if (ok) {
        keep.unshift(ok);
        kept++;
        total += ok.data.length;
      } else {
        dropped++;
      }
    }
    if (keep.length > 0) m.images = keep;
    else delete m.images;
    if (dropped > 0) m.text = [m.text, ...Array<string>(dropped).fill(IMAGE_MARK)].filter((t) => t !== '').join('\n');
  }
  return out;
}
