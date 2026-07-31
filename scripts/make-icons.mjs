#!/usr/bin/env node
/**
 * Generate the menu bar tray icons.
 *
 * Written by hand as PNGs (no design tool, no image dependency) so the repo has
 * no opaque binary asset to keep in sync.
 *
 * Two kinds:
 *  - **Template** (grayscale + alpha, color type 4) for the calm states. macOS
 *    uses only the alpha channel, so these auto-adapt to light/dark menu bars:
 *      radar        — active
 *      radar-idle   — paused (hollow ring)
 *  - **Colored** (RGBA, color type 6) for the alert state, because a template
 *    image can't carry a red badge. A fixed color can't adapt to both menu bar
 *    themes, so there are two polarities and the tray picks one by system theme:
 *      radar-alert-dark   — dark radar + red badge, for LIGHT menu bars
 *      radar-alert-light  — light radar + red badge, for DARK menu bars
 *
 * Usage: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const BADGE = [255, 45, 45]; // vivid red — meant to pop against either menu bar

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

const encode = (size, colorType, bytesPerPixel, fillRow) => {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * bytesPerPixel);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) fillRow(row, 1 + x * bytesPerPixel, x, y);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const S = 3; // 3x3 supersample
const sample = (size, at) => {
  return (acc, x, y) => {
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) acc(at(x + (sx + 0.5) / S, y + (sy + 0.5) / S, size));
    }
  };
}

/** Grayscale+alpha template PNG from `alpha(x,y,size) -> 0..1`. */
const templatePng = (size, alpha) => {
  return encode(size, 4, 2, (row, o, x, y) => {
    let a = 0;
    sample(size, alpha)((v) => (a += v), x, y);
    row[o] = 0; // black; macOS recolors via the mask
    row[o + 1] = Math.round(clamp(a / (S * S), 0, 1) * 255);
  });
}

/** RGBA PNG from `rgba(x,y,size) -> [r,g,b,a0..1]`. */
const rgbaPng = (size, rgba) => {
  return encode(size, 6, 4, (row, o, x, y) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    sample(size, rgba)((p) => {
      r += p[0];
      g += p[1];
      b += p[2];
      a += p[3];
    }, x, y);
    const n = S * S;
    row[o] = Math.round(r / n);
    row[o + 1] = Math.round(g / n);
    row[o + 2] = Math.round(b / n);
    row[o + 3] = Math.round(clamp(a / n, 0, 1) * 255);
  });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ring = (d, target, halfWidth) => Math.max(0, 1 - Math.abs(d - target) / halfWidth);
const disc = (d, radius, feather) => (d <= radius ? 1 : Math.max(0, 1 - (d - radius) / feather));

/** Radar body coverage (rings + centre dot), 0..1. */
const radarBody = (px, py, size, faint) => {
  const c = size / 2;
  const u = size / 16;
  const d = Math.hypot(px - c, py - c) / u;
  let a = ring(d, 6, faint ? 0.9 : 1.05);
  if (faint) return a * 0.85; // idle: hollow ring only
  a = Math.max(a, ring(d, 3.4, 0.95));
  a = Math.max(a, disc(d, 1.15, 0.9));
  return a;
}

/**
 * Alert glyph: the radar in `base`, plus a bold red badge at the upper-right
 * sitting in a transparent cutout so it reads as a distinct badge rather than
 * merging into the outer ring. Standard over-compositing.
 */
const alertGlyph = (base) => {
  return (px, py, size) => {
    const c = size / 2;
    const u = size / 16;
    const pcx = c + 3.9 * u;
    const pcy = c - 3.9 * u;
    const pd = Math.hypot(px - pcx, py - pcy) / u;

    let bodyA = radarBody(px, py, size, false);
    if (pd < 3.5) bodyA = 0; // cutout halo around the badge
    const badgeA = disc(pd, 2.7, 0.7); // big, so it stands out

    const outA = badgeA + bodyA * (1 - badgeA);
    if (outA <= 0) return [0, 0, 0, 0];
    const mix = (bodyC, badgeC) =>
      (badgeC * badgeA + bodyC * bodyA * (1 - badgeA)) / outA;
    return [mix(base[0], BADGE[0]), mix(base[1], BADGE[1]), mix(base[2], BADGE[2]), outA];
  };
}

mkdirSync(OUT, { recursive: true });
const write = (name, size, buf) => {
  writeFileSync(join(OUT, `${name}.png`), buf);
  console.log(`  ${name}.png (${size}x${size})`);
};

for (const [suffix, size] of [['', 16], ['@2x', 32], ['@3x', 48]]) {
  // Template (adapt to menu bar).
  write(`radar${suffix}`, size, templatePng(size, (x, y, s) => radarBody(x, y, s, false)));
  write(`radar-idle${suffix}`, size, templatePng(size, (x, y, s) => radarBody(x, y, s, true)));
  // Colored alert, both polarities.
  write(`radar-alert-dark${suffix}`, size, rgbaPng(size, alertGlyph([26, 26, 28]))); // for light menu bar
  write(`radar-alert-light${suffix}`, size, rgbaPng(size, alertGlyph([240, 240, 243]))); // for dark menu bar
}
console.log('\nTemplate: radar, radar-idle (alpha only). Colored: radar-alert-{dark,light} (red badge).');
