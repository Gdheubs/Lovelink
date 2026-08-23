import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generate the PWA's PNG icons.
 *
 * WHY GENERATE THEM RATHER THAN CHECK IN BINARIES
 * -----------------------------------------------
 * The mark is four concentric shapes and two colours — it is DEFINED by the
 * numbers below, and a checked-in PNG is a copy of that definition that drifts
 * the moment anyone adjusts the palette. Generating means `icon.svg` and every
 * PNG are the same design by construction, and a brand change is an edit to one
 * file plus a re-run.
 *
 * WHY A HAND-WRITTEN ENCODER RATHER THAN A LIBRARY
 * ------------------------------------------------
 * PNG for a solid-colour raster is genuinely small: a pixel buffer, one filter
 * byte per row, zlib, and three chunks with CRCs. Node ships zlib. Pulling an
 * image toolchain into a project whose entire premise is a dependency-free core
 * — to draw three circles, at build time — would be the wrong trade.
 *
 * WHY PNG AT ALL, WHEN AN SVG EXISTS
 * ----------------------------------
 * iOS ignores the manifest's icons entirely and uses `apple-touch-icon`, which
 * must be a PNG. Android's maskable icon needs its own art with the safe zone
 * respected, because the launcher crops it to whatever shape the device likes —
 * a circle, a squircle, a rounded square — and a mark drawn to the edge loses
 * its edges.
 *
 * Run: npm run icons
 */

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** The palette, matching globals.css. */
const BACKGROUND = [0x10, 0x0a, 0x18, 0xff];
const RING_FAINT = [0xd9, 0x8c, 0xae, 0x59];
const RING_STRONG = [0xd9, 0x8c, 0xae, 0xa6];
const CORE = [0xc4, 0x52, 0x7d, 0xff];

/**
 * The mark, in fractions of the canvas so it scales to any size.
 *
 * `maskableInset` shrinks everything for the maskable variant. Android may crop
 * up to 20% from each edge, so the whole mark has to live inside the middle
 * 80% — the spec calls it the safe zone, and ignoring it means launchers slice
 * the outer ring off.
 */
const RINGS = [
  { radius: 0.271, width: 0.036, color: RING_FAINT },
  { radius: 0.177, width: 0.036, color: RING_STRONG },
];
const CORE_RADIUS = 0.078;

/**
 * Samples per axis for anti-aliasing.
 *
 * A single sample per pixel gives a hard binary edge, which is fine at 512 and
 * visibly jagged at 180 — where the icon actually lives, on a home screen, next
 * to apps whose icons are smooth. Nine samples is enough for curves this simple
 * and costs a few milliseconds at build time.
 */
const SAMPLES = 3;

/** What colour is at this exact point, before any averaging. */
function colourAt(dx, dy, size, scale) {
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance <= CORE_RADIUS * size * scale) return CORE;

  for (const ring of RINGS) {
    const radius = ring.radius * size * scale;
    const halfWidth = (ring.width * size * scale) / 2;
    if (Math.abs(distance - radius) <= halfWidth) return ring.color;
  }

  return BACKGROUND;
}

function renderIcon(size, { maskable = false } = {}) {
  const scale = maskable ? 0.7 : 1;
  const centre = size / 2;

  // RGBA, row-major.
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          // Sample at sub-pixel centres, not corners: sampling at the corner
          // shifts the whole mark up and left by half a pixel, which is
          // visible at 192 and obvious at 48.
          const dx = x + (sx + 0.5) / SAMPLES - centre;
          const dy = y + (sy + 0.5) / SAMPLES - centre;
          const colour = colourAt(dx, dy, size, scale);

          // Composited against the background rather than left transparent:
          // the rings are drawn at partial opacity over a known backdrop, and
          // a launcher that ignores alpha would otherwise show them at full
          // strength.
          const alpha = colour[3] / 255;
          r += colour[0] * alpha + BACKGROUND[0] * (1 - alpha);
          g += colour[1] * alpha + BACKGROUND[1] * (1 - alpha);
          b += colour[2] * alpha + BACKGROUND[2] * (1 - alpha);
        }
      }

      const total = SAMPLES * SAMPLES;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(r / total);
      pixels[offset + 1] = Math.round(g / total);
      pixels[offset + 2] = Math.round(b / total);
      pixels[offset + 3] = 0xff;
    }
  }

  return encodePng(size, size, pixels);
}

// ---------------------------------------------------------------------------
// A minimal PNG encoder: signature, IHDR, IDAT, IEND.
// ---------------------------------------------------------------------------

function encodePng(width, height, rgba) {
  // Each scanline is prefixed with a filter byte. Filter 0 (None) keeps this
  // encoder trivial; for a flat-colour mark the compression difference against
  // a smarter filter is negligible and deflate does the real work.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);

  return Buffer.concat([length, body, crc]);
}

/** Standard PNG CRC-32, table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  // 192 and 512 are what Chromium's install criteria look for.
  ['icon-192.png', renderIcon(192)],
  ['icon-512.png', renderIcon(512)],
  // Its own art, drawn inside the safe zone. See the note above.
  ['icon-maskable-512.png', renderIcon(512, { maskable: true })],
  // iOS ignores the manifest and reads this tag. 180 is the size it wants.
  ['apple-touch-icon.png', renderIcon(180)],
];

for (const [name, data] of outputs) {
  writeFileSync(join(OUT_DIR, name), data);
  process.stdout.write(`  ${name}  ${data.length} bytes\n`);
}

process.stdout.write('icons written\n');
