/**
 * Renders the home-screen icons in web/public/icons from the app mark.
 *
 * The mark itself lives in web/src/components/Logo.tsx; the paths below are a
 * copy of it, so re-run this after changing that file. The PNGs are committed —
 * this is a tool for when the logo changes, not a build step.
 *
 *   npm run icons
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(repoRoot, 'web', 'public', 'icons');

/** The mark, drawn in a 72-unit box. Same shapes and colours as Logo.tsx. */
const MARK = `
  <rect x="0" y="20" width="52" height="52" rx="16" fill="#7DA6F2"/>
  <rect x="20" y="0" width="52" height="52" rx="16" fill="#2563EB"/>
  <circle cx="46" cy="26" r="9" fill="#F4F8FF"/>`;

/**
 * Each icon is the mark centred on a square, taking up `fill` of its width.
 *
 * - `any` sits on transparency and is shown as drawn, so it only needs a hair
 *   of margin.
 * - `maskable` gets cropped by the launcher to a circle, squircle or whatever
 *   shape the phone uses, and only the centre circle of 80% diameter is
 *   guaranteed to survive. The mark's farthest points are its two rounded outer
 *   corners, 44.3 units from the centre, so at 62% they land at a radius of
 *   0.38 — inside the 0.40 safe zone with a little to spare.
 * - iOS rounds the corners itself and turns transparency black, so its icon is
 *   opaque with a comfortable margin.
 */
const ICONS = [
  { file: 'icon-192.png', size: 192, fill: 0.88, background: null },
  { file: 'icon-512.png', size: 512, fill: 0.88, background: null },
  { file: 'icon-maskable-512.png', size: 512, fill: 0.62, background: '#ffffff' },
  { file: 'apple-touch-icon.png', size: 180, fill: 0.7, background: '#ffffff' },
];

function svgFor({ size, fill, background }) {
  // Growing the viewBox around the 72-unit mark is what shrinks it to `fill`.
  const pad = 36 * (1 / fill - 1);
  const box = 72 + pad * 2;
  const backdrop = background
    ? `<rect x="${-pad}" y="${-pad}" width="${box}" height="${box}" fill="${background}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-pad} ${-pad} ${box} ${box}">${backdrop}${MARK}</svg>`;
}

await fs.mkdir(OUT, { recursive: true });

for (const icon of ICONS) {
  const target = path.join(OUT, icon.file);
  await sharp(Buffer.from(svgFor(icon)))
    .png({ compressionLevel: 9 })
    .toFile(target);
  console.log(`wrote ${path.relative(repoRoot, target)} (${icon.size}×${icon.size})`);
}
