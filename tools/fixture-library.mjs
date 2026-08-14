/**
 * Builds a throwaway photo library for tests and screenshots.
 *
 * Everything here is generated, so no real photo ever ends up in the repo or in
 * CI. The images are deliberately pretty rather than plain colour blocks: the
 * same library backs the README screenshots, and a wall of flat grey tiles would
 * misrepresent what the gallery actually looks like in use.
 *
 * The layout is fixed and the PRNG is seeded, so two runs on the same day
 * produce byte-identical files — screenshots only change when the UI does.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

/** mulberry32 — small, seeded, and identical across Node versions. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sky palettes: `[zenith, horizon, sun, nearest ridge]`.
 *
 * Landscapes rather than flat gradients — at tile size these read as
 * photographs, which is the point when the same library is what the README's
 * screenshots show.
 */
const PALETTES = [
  ['#1b2a4a', '#f6a06a', '#ffd9a0', '#141d2e'], // dawn
  ['#2e5c8a', '#bfe3f5', '#fdfcf0', '#1d3b57'], // clear day
  ['#48286a', '#e2725b', '#ffbe7d', '#20142f'], // dusk
  ['#0b1a2e', '#274b6d', '#dbe9f4', '#060d18'], // night
  ['#3d7ea6', '#d8f0e6', '#fffdf2', '#22485c'], // coastal
  ['#6a3b52', '#f2b880', '#ffe6b3', '#2d1a26'], // desert evening
  ['#22513f', '#a8d5a2', '#f4ffe8', '#12291f'], // forest
  ['#7a4a2b', '#f0c987', '#fff0cf', '#33200f'], // autumn
  ['#2b3a55', '#c9d6df', '#f7fbff', '#171f2e'], // overcast
  ['#134e5e', '#71b280', '#e8f5c8', '#0a2a33'], // valley
  ['#5c2a4d', '#ff9a76', '#ffd6a0', '#2a1122'], // alpenglow
  ['#0f3057', '#8ac4d0', '#e6f4f7', '#08192e'], // lake
];

/** Landscape, portrait and square, in the proportions a real camera roll has. */
const SHAPES = [
  [1200, 800],
  [1200, 800],
  [1200, 800],
  [900, 1200],
  [900, 1200],
  [1000, 1000],
  [1600, 700],
];

/** A ridge line across the frame: a few summed sine waves, sampled to a path. */
function ridgePath(width, baseY, amplitude, height, random) {
  const waves = [
    { length: 0.9 + random() * 0.6, height: 1, phase: random() * Math.PI * 2 },
    { length: 0.35 + random() * 0.3, height: 0.45, phase: random() * Math.PI * 2 },
    { length: 0.15 + random() * 0.12, height: 0.2, phase: random() * Math.PI * 2 },
  ];

  const points = [];
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let offset = 0;
    for (const wave of waves) {
      offset += Math.sin((t / wave.length) * Math.PI * 2 + wave.phase) * wave.height;
    }
    points.push(`${(t * width).toFixed(1)},${(baseY + offset * amplitude).toFixed(1)}`);
  }

  return `M-2,${height + 2} L${points.join(' L')} L${width + 2},${height + 2} Z`;
}

/**
 * One generated scene: sky, sun, a few ridges, and sometimes water.
 *
 * Deliberately simple shapes — the point is a tile that reads as a landscape
 * photograph at 320px, not an illustration anyone would look at closely.
 */
function artwork(width, height, palette, random) {
  const [zenith, horizonColor, sunColor, ridgeColor] = palette;
  const horizonY = height * (0.52 + random() * 0.22);
  const hasWater = random() < 0.4;

  const sunX = width * (0.15 + random() * 0.7);
  const sunY = horizonY - height * (0.02 + random() * 0.22);
  const sunR = Math.min(width, height) * (0.05 + random() * 0.05);

  // Back to front, each ridge darker and taller than the one behind it.
  const ridgeCount = 3 + Math.floor(random() * 2);
  let ridges = '';
  for (let i = 0; i < ridgeCount; i++) {
    const depth = (i + 1) / ridgeCount;
    const baseY = horizonY + (height - horizonY) * (depth * 0.55);
    const amplitude = height * (0.02 + 0.05 * depth);
    // Fading the far ridges toward the sky is what gives the frame its depth.
    const opacity = (0.35 + 0.65 * depth).toFixed(2);
    ridges += `<path d="${ridgePath(width, baseY, amplitude, height, random)}" fill="${ridgeColor}" opacity="${opacity}"/>`;
  }

  const water = hasWater
    ? `<rect y="${horizonY.toFixed(1)}" width="${width}" height="${(height - horizonY).toFixed(1)}" fill="url(#water)" opacity="0.55"/>
       <ellipse cx="${sunX.toFixed(1)}" cy="${(horizonY + sunR * 1.6).toFixed(1)}" rx="${(sunR * 0.7).toFixed(1)}" ry="${(sunR * 1.8).toFixed(1)}" fill="${sunColor}" opacity="0.18"/>`
    : '';

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${zenith}"/>
          <stop offset="100%" stop-color="${horizonColor}"/>
        </linearGradient>
        <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${horizonColor}"/>
          <stop offset="100%" stop-color="${zenith}"/>
        </linearGradient>
        <radialGradient id="glow">
          <stop offset="0%" stop-color="${sunColor}" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="${sunColor}" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <rect width="${width}" height="${height}" fill="url(#sky)"/>
      <circle cx="${sunX.toFixed(1)}" cy="${sunY.toFixed(1)}" r="${(sunR * 4).toFixed(1)}" fill="url(#glow)"/>
      <circle cx="${sunX.toFixed(1)}" cy="${sunY.toFixed(1)}" r="${sunR.toFixed(1)}" fill="${sunColor}" opacity="0.9"/>
      ${water}
      ${ridges}
    </svg>`,
  );
}

/** EXIF wants `YYYY:MM:DD HH:MM:SS` in local time, with no zone designator. */
function exifStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

const CAMERAS = [
  { make: 'FUJIFILM', model: 'X-T5' },
  { make: 'Canon', model: 'Canon EOS R6' },
  { make: 'Apple', model: 'iPhone 15 Pro' },
  { make: 'SONY', model: 'ILCE-7M4' },
];

async function writePhoto(file, date, index, random) {
  const [width, height] = SHAPES[index % SHAPES.length];
  const palette = PALETTES[index % PALETTES.length];
  const camera = CAMERAS[index % CAMERAS.length];

  await sharp(artwork(width, height, palette, random))
    .jpeg({ quality: 82 })
    .withExif({
      IFD0: { Make: camera.make, Model: camera.model },
      IFD2: {
        DateTimeOriginal: exifStamp(date),
        // A plausible exposure triangle, so the details panel has real content
        // to show rather than a column of em dashes.
        ISOSpeedRatings: String(100 * (1 + (index % 8))),
        FNumber: String(1.8 + (index % 5)),
        ExposureTime: String(1 / (60 * (1 + (index % 4)))),
        FocalLength: String(24 + (index % 6) * 11),
        LensModel: 'XF16-55mmF2.8 R LM WR',
      },
    })
    .toFile(file);
}

function at(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0);
}

/**
 * The folder plan.
 *
 * Nested to two levels so the Files tree has something to expand, and split so a
 * viewer can be scoped to `Travel` alone and demonstrably not reach `Family`.
 */
function plan(now) {
  const year = now.getFullYear();
  return [
    { dir: 'Travel/Norway', count: 14, dates: (i) => at(year - 1, 6, 12 + (i % 3), 9 + (i % 8)) },
    { dir: 'Travel/Lisbon', count: 11, dates: (i) => at(year - 2, 9, 3 + (i % 2), 11 + (i % 7)) },
    { dir: 'Travel/Alps', count: 9, dates: (i) => at(year - 2, 1, 21 + (i % 3), 8 + (i % 6)) },
    { dir: 'Family/Birthdays', count: 8, dates: (i) => at(year - 1, 11, 4, 14 + (i % 5)) },
    { dir: 'Family/Garden', count: 7, dates: (i) => at(year, 4, 18 + (i % 2), 10 + (i % 6)) },
    { dir: 'Scans', count: 5, dates: (i) => at(year - 3, 3, 9, 12 + i) },
  ];
}

/**
 * Photos dated exactly one and two years ago today, so the "On this day" strip
 * has something to show whenever the suite runs.
 */
function memoryPlan(now) {
  const anniversary = (yearsAgo, i) => {
    const d = new Date(now);
    d.setFullYear(d.getFullYear() - yearsAgo);
    d.setHours(10 + (i % 8), 15, 0, 0);
    return d;
  };
  return [
    { dir: 'Travel/Norway', count: 4, dates: (i) => anniversary(1, i), prefix: 'MEM1' },
    { dir: 'Travel/Lisbon', count: 3, dates: (i) => anniversary(2, i), prefix: 'MEM2' },
  ];
}

/**
 * Writes the library and returns what was written.
 *
 * `now` is injectable so a test can pin the anniversary photos to a fixed date
 * rather than depending on the day the suite happens to run.
 */
export async function createLibrary(root, { now = new Date(), seed = 20260814 } = {}) {
  const random = seededRandom(seed);
  await fs.rm(root, { recursive: true, force: true });

  const groups = [...plan(now), ...memoryPlan(now)];
  const files = [];
  let index = 0;

  for (const group of groups) {
    const dirAbs = path.join(root, group.dir);
    await fs.mkdir(dirAbs, { recursive: true });

    for (let i = 0; i < group.count; i++) {
      const date = group.dates(i);
      const stamp =
        `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}` +
        `${String(date.getDate()).padStart(2, '0')}`;
      const name = `${group.prefix ?? 'IMG'}_${stamp}_${String(i + 1).padStart(3, '0')}.jpg`;
      const file = path.join(dirAbs, name);

      await writePhoto(file, date, index, random);
      files.push({ rel: `${group.dir}/${name}`, takenAt: date.getTime() });
      index++;
    }
  }

  // One file the gallery indexes but cannot thumbnail, so the Files tab has a
  // realistic unsupported entry and the feed demonstrably excludes it.
  await fs.writeFile(path.join(root, 'Scans', 'negative-strip.dng'), 'not a real raw file');

  // A README inside the library: the file browser lists non-media too.
  await fs.writeFile(
    path.join(root, 'Travel', 'packing-list.txt'),
    'boots\ncharger\nspare battery\n',
  );

  return { root, files, count: files.length };
}

/** Photo count without writing anything — handy for asserting totals. */
export function expectedPhotoCount(now = new Date()) {
  return [...plan(now), ...memoryPlan(now)].reduce((sum, g) => sum + g.count, 0);
}
