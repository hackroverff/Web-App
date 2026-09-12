/**
 * Placeholder product artwork: tiny, deterministic SVGs (no stock photos, no
 * brand imagery, no network calls). Each product gets a category-tinted card
 * with a simple motif and its initials, so the grid reads as a real catalogue
 * while staying ~700 bytes per file and fully offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR } from '../config.js';

const OUT_DIR = path.join(PUBLIC_DIR, 'img', 'products');

export const PALETTE = {
  'Grocery & Staples': { bg: '#eaf5ee', fg: '#0f7b4f', glyph: 'sack' },
  'Beverages': { bg: '#e8f1fb', fg: '#1e5f8f', glyph: 'cup' },
  'Snacks': { bg: '#fdf1e3', fg: '#b9621a', glyph: 'snack' },
  'Dairy & Breakfast': { bg: '#f2f4fb', fg: '#3f4d94', glyph: 'milk' },
  'Personal Care': { bg: '#fdeef3', fg: '#a3346a', glyph: 'soap' },
  'Household': { bg: '#e9f6f7', fg: '#157178', glyph: 'spray' },
  'Kitchen Essentials': { bg: '#f6f0e6', fg: '#7a5a25', glyph: 'pot' },
  'Puja & Festivals': { bg: '#fdf0e6', fg: '#a4530f', glyph: 'lamp' },
};

const GLYPHS = {
  sack: `<path d="M44 30c0-6 5-9 12-9s12 3 12 9c0 5-4 7-4 12 0 8 5 10 5 19 0 9-7 14-13 14s-13-5-13-14c0-9 5-11 5-19 0-5-4-7-4-12z" fill="CUR" opacity=".9"/><path d="M50 21h12" stroke="BG" stroke-width="3" stroke-linecap="round"/>`,
  cup: `<path d="M40 34h30l-3 34a6 6 0 0 1-6 5H49a6 6 0 0 1-6-5z" fill="CUR" opacity=".9"/><path d="M70 40h6a6 6 0 0 1 0 12h-4" stroke="CUR" stroke-width="3" fill="none"/><path d="M46 26c2-4 0-6 2-9M54 26c2-4 0-6 2-9M62 26c2-4 0-6 2-9" stroke="CUR" stroke-width="2.5" stroke-linecap="round" fill="none" opacity=".7"/>`,
  snack: `<path d="M34 30h44l-4 40a6 6 0 0 1-6 5H44a6 6 0 0 1-6-5z" fill="CUR" opacity=".85"/><path d="M34 30l8-8h28l8 8" stroke="CUR" stroke-width="3" fill="none"/><path d="M44 44h24M44 52h20" stroke="BG" stroke-width="3" stroke-linecap="round"/>`,
  milk: `<path d="M46 24h20v8l6 10v30a6 6 0 0 1-6 6H46a6 6 0 0 1-6-6V42l6-10z" fill="CUR" opacity=".9"/><path d="M44 50h24" stroke="BG" stroke-width="3"/>`,
  soap: `<rect x="34" y="40" width="44" height="28" rx="8" fill="CUR" opacity=".9"/><path d="M46 32c0-6 4-8 8-8" stroke="CUR" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="60" cy="54" r="6" fill="BG" opacity=".55"/>`,
  spray: `<path d="M44 42h22a5 5 0 0 1 5 5v21a5 5 0 0 1-5 5H44a5 5 0 0 1-5-5V47a5 5 0 0 1 5-5z" fill="CUR" opacity=".9"/><path d="M50 42V30h10l8 6" stroke="CUR" stroke-width="4" fill="none" stroke-linejoin="round"/><path d="M70 30l8-4" stroke="CUR" stroke-width="3" stroke-linecap="round"/>`,
  pot: `<path d="M32 44h48v14a12 12 0 0 1-12 12H44a12 12 0 0 1-12-12z" fill="CUR" opacity=".9"/><path d="M28 44h56" stroke="CUR" stroke-width="4" stroke-linecap="round"/><path d="M56 28c6 0 8 4 8 8" stroke="CUR" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  lamp: `<path d="M40 58c0 8 8 12 16 12s16-4 16-12z" fill="CUR" opacity=".9"/><path d="M56 30c6 6 6 12 0 18-6-6-6-12 0-18z" fill="CUR"/><path d="M34 58h44" stroke="CUR" stroke-width="3" stroke-linecap="round"/>`,
};

const slugify = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 44);

function initials(name) {
  const words = String(name).replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
  const two = words.slice(0, 2).map((w) => w[0]).join('');
  return (two || name.slice(0, 2)).toUpperCase();
}

export function svgFor({ name, category, packSize, pack_size: packSnake }) {
  // `packSize` from the seed, `pack_size` from a row straight out of the DB: both must paint the
  // same file, or whichever tool ran last silently rewrites the committed artwork.
  packSize = packSize ?? packSnake ?? '';
  const pal = PALETTE[category] || { bg: '#eef4ef', fg: '#0f7b4f', glyph: 'sack' };
  const glyph = (GLYPHS[pal.glyph] || GLYPHS.sack).replaceAll('CUR', pal.fg).replaceAll('BG', pal.bg);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" role="img" aria-label="${escapeAttr(name)}">
<rect width="120" height="100" rx="14" fill="${pal.bg}"/>
<g transform="translate(4 2)">${glyph}</g>
<text x="110" y="16" text-anchor="end" font-family="system-ui,sans-serif" font-size="8.5" fill="${pal.fg}" opacity=".65">${escapeXml(packSize || '')}</text>
<text x="110" y="92" text-anchor="end" font-family="system-ui,sans-serif" font-size="13" font-weight="800" fill="${pal.fg}" opacity=".22">${escapeXml(initials(name))}</text>
</svg>`;
}

/**
 * Static artwork lives in `public/`, which is committed — so on a read-only deployment
 * (serverless functions, containers with a mounted read-only volume) the files are already
 * there and the write is pure redundancy. Skip it instead of failing the boot; the DB row
 * still points at the same URL, and product cards fall back to the placeholder on a 404.
 */
function tryWrite(file, contents) {
  try {
    // Idempotent on purpose: seeding a throwaway test database runs this same generator, and
    // without the content check every `npm test` rewrites tracked artwork in public/ — leaving
    // the repo dirty (or, worse, quietly repainting cards from a different catalogue).
    try {
      if (fs.readFileSync(file, 'utf8') === contents) return false;
    } catch {
      /* missing: write it */
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return true;
  } catch {
    return false;
  }
}

export function ensureProductImages(products) {
  // The card components fall back to this when a product has no artwork (a newly
  // created item before its first save, or a hand-rolled catalogue import).
  tryWrite(
    path.join(OUT_DIR, 'placeholder-1.svg'),
    svgFor({ name: 'Sathvika MV', category: 'Grocery & Staples', packSize: '' }),
  );
  const written = [];
  for (const p of products) {
    const file = path.join(OUT_DIR, `${slugify(p.name)}.svg`);
    // Callers arrive with either shape: the seed hands over { name, category, packSize }, a
    // regeneration from the DB hands over { name, category, pack_size }. Read both, or the pack
    // size silently vanishes from the artwork depending on which path painted the file last.
    const svg = svgFor({ name: p.name, category: p.category, packSize: p.packSize ?? p.pack_size });
    tryWrite(file, svg);
    written.push(path.posix.join('/img/products', path.basename(file)));
  }
  return written;
}

export function ensureCategoryArt() {
  const dir = path.join(PUBLIC_DIR, 'img', 'categories');
  for (const [name, pal] of Object.entries(PALETTE)) {
    const glyph = (GLYPHS[pal.glyph] || GLYPHS.sack).replaceAll('CUR', pal.fg).replaceAll('BG', pal.bg);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100"><rect width="120" height="100" rx="18" fill="${pal.bg}"/><g transform="scale(1.05) translate(2 2)">${glyph}</g></svg>`;
    tryWrite(path.join(dir, `${slugify(name)}.svg`), svg);
  }
  return Object.keys(PALETTE);
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}
const escapeAttr = escapeXml;

export const categorySlug = slugify;
