/**
 * Brand artwork pipeline — no dependencies, no ImageMagick.
 *
 *   node scripts/build-logo.js [path/to/logo.png]
 *
 * If a source raster is given (or lives at public/img/brand/source.png) it is decoded,
 * resampled and written out as every size the app and the manifest ask for:
 *
 *   public/img/logo.png                    the artwork, square, for splash + header
 *   public/img/icon-192.png                PWA / Android launcher icon
 *   public/img/icon-512.png                PWA icon, large
 *   public/img/icon-maskable-192.png       maskable (art inset in the 80% safe zone)
 *   public/img/icon-maskable-512.png
 *
 * Without a source file the same outputs are drawn from the crest vector in
 * public/img/logo.svg, so a fresh clone still has real icons. PNG decoding,
 * resampling and encoding are implemented here because the only binary in the
 * toolchain we can rely on is Node itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imgDir = path.join(root, 'public', 'img');
const brandDir = path.join(imgDir, 'brand');

const GOLD = [201, 162, 39, 255];
const GOLD_DARK = [150, 112, 20, 255];
const MAROON = [138, 26, 43, 255];
const MAROON_DARK = [104, 18, 30, 255];
const CREAM = [255, 250, 238, 255];
const CLEAR = [0, 0, 0, 0];

/* ------------------------------------------------------------------ decode -- */
/** Minimal PNG reader: 8-bit grey/RGB/RGBA/palette, non-interlaced, no Adam7. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        compress: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG without IHDR');
  if (ihdr.interlace !== 0) throw new Error('interlaced PNGs are not supported — export a plain PNG');
  if (ihdr.depth !== 8) throw new Error(`only 8-bit PNGs are supported (got ${ihdr.depth}-bit)`);
  const { width, height, color } = ihdr;
  const channels = color === 6 ? 4 : color === 2 ? 3 : color === 0 ? 1 : color === 4 ? 2 : color === 3 ? 1 : -1;
  if (channels < 0) throw new Error(`unsupported PNG colour type ${color}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      cur[x] = v & 0xff;
    }
    prev = cur;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    if (color === 3) {
      const idx = out[i];
      rgba[i * 4] = plte[idx * 3];
      rgba[i * 4 + 1] = plte[idx * 3 + 1];
      rgba[i * 4 + 2] = plte[idx * 3 + 2];
      rgba[i * 4 + 3] = trns ? (trns[idx] ?? 0) : 255;
    } else {
      for (let ch = 0; ch < channels; ch += 1) rgba[i * 4 + ch] = out[i * channels + ch];
      if (channels === 1) { rgba[i * 4 + 1] = out[i]; rgba[i * 4 + 2] = out[i]; rgba[i * 4 + 3] = 255; }
      else if (channels === 2) { rgba[i * 4 + 1] = out[i * 2]; rgba[i * 4 + 2] = out[i * 2]; rgba[i * 4 + 3] = out[i * 2 + 1]; }
      else if (channels === 3) rgba[i * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/* ------------------------------------------------------------------- scale -- */
/** Box-average downscale / bilinear-ish upscale, one call, returns RGBA buffer. */
export function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * sw + sx) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += src[i + 3];
          n += 1;
        }
      }
      const o = (y * dw + x) * 4;
      if (!n) continue;
      const alpha = a / n / 255;
      out[o] = alpha > 0 ? Math.round(r / n / alpha) : 0;
      out[o + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      out[o + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Cover-crop to a square first so tall/wide artwork never ends up squashed. */
function squareCrop(rgba, w, h) {
  const side = Math.min(w, h);
  const x0 = Math.floor((w - side) / 2);
  const y0 = Math.floor((h - side) / 2);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    rgba.copy(out, y * side * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + side) * 4);
  }
  return { rgba: out, size: side };
}

function flatten(rgba, size, bg) {
  for (let i = 0; i < size * size; i += 1) {
    const a = rgba[i * 4 + 3] / 255;
    for (let ch = 0; ch < 3; ch += 1) {
      rgba[i * 4 + ch] = Math.round(rgba[i * 4 + ch] * a + bg[ch] * (1 - a));
    }
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Put the artwork inside the maskable safe zone (centre 80%) on a solid tile. */
function maskable(rgba, size, bg) {
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = bg[0];
    out[i * 4 + 1] = bg[1];
    out[i * 4 + 2] = bg[2];
    out[i * 4 + 3] = 255;
  }
  const inner = Math.floor(size * 0.78);
  const off0 = Math.floor((size - inner) / 2);
  const small = resample(rgba, size, size, inner, inner);
  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const s = (y * inner + x) * 4;
      const a = small[s + 3] / 255;
      const d = ((y + off0) * size + (x + off0)) * 4;
      for (let ch = 0; ch < 3; ch += 1) out[d + ch] = Math.round(small[s + ch] * a + out[d + ch] * (1 - a));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ encode -- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------- fallback crest raster -- */
/* Same geometry as public/img/logo.svg, drawn with distance fields. */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function sdCircle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r;
}

/** Axis-aligned rounded box, used for the banner body. */
function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

/** A horizontal capsule (the crown band and the sack tie). */
function sdRoundBar(x, y, cx, cy, halfLen, halfThick) {
  return sdRoundBox(x, y, cx, cy, halfLen, halfThick, halfThick);
}

function sdRing(x, y, cx, cy, r, w) {
  return Math.abs(sdCircle(x, y, cx, cy, r)) - w;
}

/** Convex polygon distance (used for the crown and the ribbon ends). */
function sdPoly(x, y, pts) {
  let d = 1e9;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[j];
    const ex = x2 - x1;
    const ey = y2 - y1;
    const px = x - x1;
    const py = y - y1;
    const t = clamp01((px * ex + py * ey) / (ex * ex + ey * ey || 1));
    d = Math.min(d, Math.hypot(px - ex * t, py - ey * t));
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1 || 1e-9) + x1) inside = !inside;
  }
  return inside ? -d : d;
}

function paintCrest(px, py, size) {
  const s = size / 512;
  const x = px / s;
  const y = py / s;
  const AA = Math.max(1.1, 1.6 * s);
  const cover = (d) => clamp01(0.5 - d / AA);
  const mix = (a, b, t) => (t <= 0 ? a : [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    255,
  ]);
  const CX = 256;
  const CY = 268;

  const inFrame = cover(sdCircle(x, y, CX, CY, 252));
  if (inFrame <= 0) return CLEAR;

  // gold ring, maroon field, thin inner ring
  let col = mix(GOLD, GOLD_DARK, clamp01((y - 20) / 460));
  const ringLine = cover(sdRing(x, y, CX, CY, 232, 3));
  col = mix(col, MAROON, cover(sdCircle(x, y, CX, CY, 214)));
  col = mix(col, GOLD_DARK, ringLine);

  // crown riding on top of the ring: a band plus three points (a union of convex
  // shapes, because a concave polygon reads badly through a distance field)
  col = mix(col, GOLD, cover(sdRoundBar(x, y, CX, 116, 72, 12)));
  for (const [bx, tip, half] of [[204, 52, 26], [CX, 34, 28], [308, 52, 26]]) {
    col = mix(col, GOLD, cover(sdPoly(x, y, [[bx - half, 112], [bx + half, 112], [bx, tip]])));
    col = mix(col, GOLD, cover(sdCircle(x, y, bx, tip - 8, 8)));
  }
  for (const bx of [206, CX, 306]) col = mix(col, MAROON_DARK, cover(sdCircle(x, y, bx, 116, 5)));

  // cream medallion
  col = mix(col, [246, 226, 176, 255], cover(sdCircle(x, y, CX, CY, 133)));
  col = mix(col, CREAM, cover(sdCircle(x, y, CX, CY, 127)));
  col = mix(col, GOLD, cover(sdRing(x, y, CX, CY, 120, 2.5)));

  // provision sack with a gold tie, then a star above it
  const sack = sdPoly(x, y, [
    [CX - 44, CY - 40], [CX + 44, CY - 40], [CX + 52, CY + 6], [CX + 40, CY + 54],
    [CX, CY + 64], [CX - 40, CY + 54], [CX - 52, CY + 6],
  ]);
  col = mix(col, MAROON, cover(sack));
  col = mix(col, MAROON_DARK, cover(sdCircle(x, y, CX, CY - 40, 12)) * 0.9);
  col = mix(col, GOLD, cover(sdRoundBar(x, y, CX, CY - 48, 30, 6)));
  const star = cover(sdPoly(x, y, starPoints(CX, CY - 4, 17)));
  col = mix(col, [246, 226, 176, 255], star);

  // ribbon across the lower field, with notched tails
  const banner = sdRoundBox(x, y, CX, 424, 140, 24, 8);
  const tailL = sdPoly(x, y, [[88, 404], [120, 404], [120, 448], [88, 448], [104, 426]]);
  const tailR = sdPoly(x, y, [[424, 404], [392, 404], [392, 448], [424, 448], [408, 426]]);
  col = mix(col, GOLD_DARK, cover(Math.min(tailL, tailR)));
  col = mix(col, GOLD, cover(banner));
  col = mix(col, GOLD_DARK, cover(sdRoundBox(x, y, CX, 444, 140, 3, 2)) * 0.7);

  // star row under the ribbon
  for (let i = 0; i < 5; i += 1) {
    col = mix(col, GOLD, cover(sdPoly(x, y, starPoints(176 + i * 40, 474, 9))));
  }
  return col;
}

/** Vertices of a 5-pointed star (outer radius R) — used by the polygon distance. */
function starPoints(cx, cy, R) {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : R * 0.44;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}

function renderCrest(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const c = paintCrest(x, y, size);
      const i = (y * size + x) * 4;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = c[3];
    }
  }
  return rgba;
}

/* --------------------------------------------------------------------- run -- */
function writeOut(name, buffer) {
  const file = path.join(imgDir, name);
  fs.writeFileSync(file, buffer);
  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`  · public/img/${name}  ${kb} kB`);
}

export function buildLogo(sourceArg) {
  const candidates = [sourceArg, path.join(brandDir, 'source.png')].filter(Boolean);
  const source = candidates.find((f) => fs.existsSync(f));
  fs.mkdirSync(imgDir, { recursive: true });

  if (!source) {
    console.log('no brand source image — drawing the crest fallback\n');
    const crest512 = renderCrest(512);
    writeOut('logo.png', encodePng(512, crest512));
    writeOut('icon-512.png', encodePng(512, crest512));
    writeOut('icon-192.png', encodePng(192, resample(crest512, 512, 512, 192, 192)));
    writeOut('icon-maskable-512.png', encodePng(512, maskable(crest512, 512, CREAM)));
    writeOut('icon-maskable-192.png', encodePng(192, resample(maskable(crest512, 512, CREAM), 512, 512, 192, 192)));
    console.log('\n  to use real artwork: save it as public/img/brand/source.png and re-run npm run logo');
    return { source: null };
  }

  const { width, height, rgba } = decodePng(fs.readFileSync(source));
  const sq = squareCrop(rgba, width, height);
  const big = resample(sq.rgba, sq.size, sq.size, 512, 512);
  const opaque = flatten(Buffer.from(big), 512, [255, 255, 255]);
  const small = resample(opaque, 512, 512, 192, 192);
  writeOut('logo.png', encodePng(512, opaque));
  writeOut('icon-512.png', encodePng(512, opaque));
  writeOut('icon-192.png', encodePng(192, small));
  writeOut('icon-maskable-512.png', encodePng(512, maskable(Buffer.from(opaque), 512, CREAM)));
  writeOut('icon-maskable-192.png', encodePng(192, resample(maskable(Buffer.from(opaque), 512, 512, CREAM), 512, 512, 192, 192)));
  // Everything in the app points at /img/logo.svg (splash, header, PIN pad, favicon), so the
  // raster is wrapped in a one-line SVG instead of teaching every consumer a new path.
  fs.writeFileSync(
    path.join(imgDir, 'logo.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Sathvika MV">
  <image href="logo.png" width="512" height="512" preserveAspectRatio="xMidYMid meet"/>
</svg>
`,
  );
  console.log('  · public/img/logo.svg   (wraps logo.png)');
  const copy = path.join(brandDir, 'source.png');
  if (path.resolve(source) !== path.resolve(copy)) {
    fs.mkdirSync(brandDir, { recursive: true });
    fs.copyFileSync(source, copy);
    console.log(`  · public/img/brand/source.png  (kept for the next run)`);
  }
  console.log(`\n  ✓ built from ${width}×${height} ${path.basename(source)}`);
  return { source, width, height };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) buildLogo(process.argv[2]);
