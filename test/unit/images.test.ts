import { describe, expect, it } from 'vitest';
import { applyImagePolicy, IMAGE_MARK, imageInfo, MAX_IMAGE_BASE64, MAX_IMAGES_BASE64_TOTAL, MAX_IMAGES_PER_SESSION, parseDataUrl, toDataUrl } from '../../src/main/core/images.js';
import type { PreparedMessage } from '../../src/main/core/render.js';

// 형식 판별·크기 읽기에 필요한 머리 바이트만 가진 최소 이미지(base64)
const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
};
const jpeg = (w: number, h: number) => {
  // SOI, APP0(JFIF, 길이 16), SOF0(길이 17)
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]).copy(sof, 0);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]).toString('base64');
};
const gif = (w: number, h: number) => {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b.toString('base64');
};
const webp = (kind: 'VP8X' | 'VP8L' | 'VP8 ', w: number, h: number) => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  if (kind === 'VP8X') {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  } else if (kind === 'VP8L') {
    b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  } else {
    Buffer.from([0x9d, 0x01, 0x2a]).copy(b, 23);
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  }
  return b.toString('base64');
};

describe('parseDataUrl / toDataUrl', () => {
  it('splits a base64 data URL into media type and data, and round-trips', () => {
    expect(parseDataUrl('data:image/PNG;base64,AAAA')).toEqual({ mediaType: 'image/png', data: 'AAAA' });
    expect(toDataUrl({ mediaType: 'image/png', data: 'AAAA' })).toBe('data:image/png;base64,AAAA');
    expect(parseDataUrl('https://example.com/a.png')).toBeUndefined();
    expect(parseDataUrl('data:image/png,rawnotbase64')).toBeUndefined();
  });
});

describe('imageInfo', () => {
  it('recognises PNG, JPEG, GIF and the three WebP variants by their bytes, with pixel size', () => {
    expect(imageInfo(png(1920, 1080))).toEqual({ mediaType: 'image/png', width: 1920, height: 1080 });
    expect(imageInfo(jpeg(800, 600))).toEqual({ mediaType: 'image/jpeg', width: 800, height: 600 });
    expect(imageInfo(gif(32, 16))).toEqual({ mediaType: 'image/gif', width: 32, height: 16 });
    expect(imageInfo(webp('VP8X', 3000, 2000))).toEqual({ mediaType: 'image/webp', width: 3000, height: 2000 });
    expect(imageInfo(webp('VP8L', 640, 480))).toEqual({ mediaType: 'image/webp', width: 640, height: 480 });
    expect(imageInfo(webp('VP8 ', 1024, 768))).toEqual({ mediaType: 'image/webp', width: 1024, height: 768 });
  });
  it('returns undefined for anything else (e.g. BMP, garbage)', () => {
    expect(imageInfo(Buffer.from('BM______________________________').toString('base64'))).toBeUndefined();
    expect(imageInfo('AAAA')).toBeUndefined();
  });
});

describe('applyImagePolicy', () => {
  const msg = (text: string, images?: { mediaType: string; data: string }[]): PreparedMessage => ({ role: 'user', text, ...(images ? { images } : {}) });

  it('keeps valid images, corrects a wrong declared media type, and leaves messages without images alone', () => {
    const input = [msg('안내'), msg('이거 봐', [{ mediaType: 'image/png', data: jpeg(800, 600) }])];
    const out = applyImagePolicy(input, 'claude');
    expect(out[0]).toEqual(msg('안내'));
    expect(out[1]).toEqual(msg('이거 봐', [{ mediaType: 'image/jpeg', data: jpeg(800, 600) }]));
    expect(input[1]!.images![0]!.mediaType).toBe('image/png'); // 입력은 바꾸지 않는다
  });

  it('drops images Claude could reject later (long edge over 2000px) but keeps them for Codex', () => {
    const big = [msg('크다', [{ mediaType: 'image/png', data: png(3840, 2160) }])];
    expect(applyImagePolicy(big, 'claude')).toEqual([msg(`크다\n${IMAGE_MARK}`)]);
    expect(applyImagePolicy(big, 'codex')).toEqual(big);
    // 형식은 알지만 크기를 못 읽는 이미지(모르는 WebP 청크)는 Claude 로는 옮기지 않고, Codex 로는 옮긴다
    const odd = Buffer.from(webp('VP8X', 100, 100), 'base64');
    odd.write('VP8?', 12, 'latin1');
    const unknownSize = [msg('', [{ mediaType: 'image/webp', data: odd.toString('base64') }])];
    expect(imageInfo(odd.toString('base64'))).toEqual({ mediaType: 'image/webp' });
    expect(applyImagePolicy(unknownSize, 'claude')).toEqual([msg(IMAGE_MARK)]);
    expect(applyImagePolicy(unknownSize, 'codex')).toEqual(unknownSize);
  });

  it('drops unknown formats and oversize data, leaving a marker after the text', () => {
    const out = applyImagePolicy([msg('두 장', [{ mediaType: 'image/bmp', data: 'AAAA' }, { mediaType: 'image/png', data: png(10, 10) + 'A'.repeat(MAX_IMAGE_BASE64) }])], 'codex');
    expect(out).toEqual([msg(`두 장\n${IMAGE_MARK}\n${IMAGE_MARK}`)]);
  });

  it('stops keeping images once their total would pass the session budget (resumed requests must stay under the 32MB API limit)', () => {
    // 4.5MB 짜리 5장(각각은 5MB 이하) — 합계 20MB 를 넘는 가장 오래된 1장은 표시로
    const big = (w: number) => ({ mediaType: 'image/png', data: png(w, 10) + 'A'.repeat(4.5 * 1024 * 1024) });
    const out = applyImagePolicy([msg('다섯 장', [big(1), big(2), big(3), big(4), big(5)])], 'codex');
    expect(out[0]!.images!.map((i) => imageInfo(i.data)!.width)).toEqual([2, 3, 4, 5]);
    expect(out[0]!.text).toBe(`다섯 장\n${IMAGE_MARK}`);
    expect(out[0]!.images!.reduce((s, i) => s + i.data.length, 0)).toBeLessThanOrEqual(MAX_IMAGES_BASE64_TOTAL);
  });

  it(`keeps only the latest ${MAX_IMAGES_PER_SESSION} images across the conversation`, () => {
    const images = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ mediaType: 'image/png', data: png(from + i, 10) }));
    const out = applyImagePolicy([msg('앞', images(5, 1)), msg('뒤', images(18, 100))], 'claude');
    expect(out[1]!.images).toHaveLength(18);
    expect(out[0]!.images!.map((i) => imageInfo(i.data)!.width)).toEqual([4, 5]); // 앞 메시지는 가장 나중 두 장만
    expect(out[0]!.text).toBe(`앞\n${IMAGE_MARK}\n${IMAGE_MARK}\n${IMAGE_MARK}`);
  });
});
