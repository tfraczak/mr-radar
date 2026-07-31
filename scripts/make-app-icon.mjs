#!/usr/bin/env node
/**
 * Generate the app icon (assets/app-icon.png, 1024x1024 RGBA).
 *
 * Unlike the tray icons (monochrome template images), the app icon is full
 * color: a white radar on a blue rounded-square, matching the app's accent.
 * electron-builder converts this PNG to .icns at package time, so no iconutil
 * step is needed.
 *
 * Written by hand as an RGBA PNG (color type 6) to keep the repo free of binary
 * design assets and image-library dependencies.
 *
 * Usage: node scripts/make-app-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const SIZE = 1024;

const crc32 = (buf) => {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `pixel(x, y) -> [r, g, b, a]` (0..255), supersampled 3x for smooth edges. */
const png = (size, pixel) => {
  const S = 3;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const [pr, pg, pb, pa] = pixel(x + (sx + 0.5) / S, y + (sy + 0.5) / S, size);
          r += pr;
          g += pg;
          b += pb;
          a += pa;
        }
      }
      const n = S * S;
      const o = 1 + x * 4;
      row[o] = Math.round(r / n);
      row[o + 1] = Math.round(g / n);
      row[o + 2] = Math.round(b / n);
      row[o + 3] = Math.round(a / n);
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded square centred in the icon. */
const roundedSquareAlpha = (x, y, size) => {
  const c = size / 2;
  const half = size * 0.42; // leaves macOS-ish padding around the tile
  const radius = size * 0.115;
  const dx = Math.abs(x - c) - (half - radius);
  const dy = Math.abs(y - c) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius;
  const inside = Math.min(Math.max(dx, dy), 0);
  const d = outside + inside;
  return clamp(0.5 - d, 0, 1); // ~1px feather
}

const ring = (d, target, halfWidth) => {
  return Math.max(0, 1 - Math.abs(d - target) / halfWidth);
}
const disc = (d, radius, feather) => {
  return d <= radius ? 1 : Math.max(0, 1 - (d - radius) / feather);
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

const iconPixel = (x, y, size) => {
  const bgA = roundedSquareAlpha(x, y, size);
  if (bgA <= 0) return [0, 0, 0, 0];

  // Blue tile with a soft top-to-bottom gradient (accent -> deeper).
  const t = y / size;
  const bg = [
    Math.round(lerp(46, 8, t)),
    Math.round(lerp(126, 92, t)),
    Math.round(lerp(255, 230, t)),
  ];

  // White radar, sized in units where the whole glyph spans the tile.
  const c = size / 2;
  const u = size / 16;
  const d = Math.hypot(x - c, y - c) / u;
  let mark = 0;
  mark = Math.max(mark, ring(d, 4.7, 0.62)); // outer ring
  mark = Math.max(mark, ring(d, 2.7, 0.55)); // inner ring
  mark = Math.max(mark, disc(d, 0.95, 0.5)); // centre dot
  mark = clamp(mark, 0, 1);

  // The sweep pip is red, matching the tray's alert badge. It sits in a small
  // transparent cutout so it reads as a distinct dot, not a white smudge.
  const pd = Math.hypot(x - (c + 3.5 * u), y - (c - 3.5 * u)) / u;
  const pip = clamp(disc(pd, 1.05, 0.4), 0, 1);
  if (pd < 1.7) mark = 0; // cutout so the red dot separates from the white rings

  const white = [255, 255, 255];
  const red = [255, 59, 48];
  // base tile → white radar → red pip, composited in that order.
  const compose = (i) => {
    const withRadar = lerp(bg[i], white[i], mark);
    return Math.round(lerp(withRadar, red[i], pip));
  };
  return [compose(0), compose(1), compose(2), Math.round(bgA * 255)];
}

mkdirSync(OUT, { recursive: true });
const file = join(OUT, 'app-icon.png');
writeFileSync(file, png(SIZE, iconPixel));
console.log(`  wrote ${file} (${SIZE}x${SIZE} RGBA)`);
