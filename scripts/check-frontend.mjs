/**
 * Static sanity sweep for the SPA:
 *  1. every t('key') used exists in the i18n dictionary
 *  2. every icon name referenced (icons.foo / icons['foo'] / { html: icons.foo }) exists in the icon map
 *  3. every named import resolves to an export in the referenced module
 *  4. every fetch path starts with /api/ and matches a registered server route
 * Exits non-zero and prints a report on any problem.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'public/app';
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
};
walk(ROOT);

const read = (f) => fs.readFileSync(f, 'utf8');

/* 1 — i18n keys ------------------------------------------------------------- */
/** Drop comments (and, for the call scan, string/template payloads). */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripData = (src) => strip(src).replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""').replace(/`[^`]*`/gs, '``');
const i18nSrc = strip(read('public/app/core/i18n.js'));
const dictKeys = new Set([...i18nSrc.matchAll(/^\s*'([a-z0-9_.]+)':\s*\[/gmi)].map((m) => m[1]));
const usedKeys = new Map();
for (const f of files) {
  const src = strip(read(f));
  for (const m of src.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)) {
    if (!usedKeys.has(m[1])) usedKeys.set(m[1], new Set());
    usedKeys.get(m[1]).add(f);
  }
  // template-literal keys such as t(`order.status.${x}`) — record the prefix
  for (const m of src.matchAll(/\bt\(\s*`([a-z0-9_.]*)\$\{/g)) {
    if (!usedKeys.has(`${m[1]}*`)) usedKeys.set(`${m[1]}*`, new Set());
    usedKeys.get(`${m[1]}*`).add(f);
  }
}
const missingKeys = [];
for (const [key, where] of usedKeys) {
  if (key.endsWith('*')) {
    const prefix = key.slice(0, -1);
    if (![...dictKeys].some((d) => d.startsWith(prefix))) missingKeys.push([key, [...where][0]]);
    continue;
  }
  if (!dictKeys.has(key)) missingKeys.push([key, [...where].join(', ')]);
}
const unusedKeys = [...dictKeys].filter((k) => !usedKeys.has(k) && !k.startsWith('app.') && !usedKeys.has(`${k.split('.')[0]}*`));

/* 2 — icons ---------------------------------------------------------------- */
const iconSrc = read('public/app/core/icons.js');
const iconNames = new Set([...iconSrc.matchAll(/^\s{2}([a-zA-Z0-9_]+):\s*'/gm)].map((m) => m[1]));
const missingIcons = [];
for (const f of files) {
  if (f.endsWith('icons.js')) continue;
  const src = read(f);
  const refs = new Set();
  for (const m of src.matchAll(/\bicons\.([a-zA-Z0-9_]+)/g)) refs.add(m[1]);
  for (const m of src.matchAll(/\bicons\['([a-zA-Z0-9_]+)'\]/g)) refs.add(m[1]);
  for (const m of src.matchAll(/icon\(\s*'([a-zA-Z0-9_]+)'/g)) refs.add(m[1]);
  for (const m of src.matchAll(/iconName\s*=\s*'([a-zA-Z0-9_]+)'/g)) refs.add(m[1]);
  for (const m of src.matchAll(/\bicon:\s*'([a-zA-Z0-9_]+)'/g)) refs.add(m[1]);
  for (const m of src.matchAll(/icons\[([^\]]+)\]\s*\|\|\s*icons\.([a-zA-Z0-9_]+)/g)) refs.add(m[2]);
  for (const n of refs) if (n !== 'js' && !iconNames.has(n)) missingIcons.push(`${n} (in ${f})`);
}

/* 3 — imports -------------------------------------------------------------- */
const exportNames = (file) => {
  const src = read(file);
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
};
const badImports = [];
for (const f of files) {
  const src = read(f);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const target = path.resolve(path.dirname(f), m[2]);
    if (!fs.existsSync(target)) { badImports.push(`${f}: missing file ${m[2]}`); continue; }
    const available = exportNames(target);
    for (const part of m[1].split(',')) {
      const raw = part.trim();
      if (!raw) continue;
      const name = raw.split(/\s+as\s+/)[0].trim();
      if (!available.has(name)) badImports.push(`${f}: '${name}' is not exported by ${m[2]}`);
    }
  }
  for (const m of src.matchAll(/import\s+([a-zA-Z0-9_$]+)\s+from/g)) {
    badImports.push(`${f}: default import '${m[1]}' — check the target module exports default`);
  }
}

/* 4 — api paths ------------------------------------------------------------ */
const routesSrc = read('server/app.js');
const mountLines = [...routesSrc.matchAll(/app\.use\('([^']+)\',\s*(\w+)\)/g)]
  .map((m) => ({ base: m[1], var: m[2] }))
  .filter((m) => m.var.endsWith('Router'));
const serverPaths = new Set([...routesSrc.matchAll(/app\.(?:get|post|put|patch|delete)\('([^']+)'/g)].map((m) => m[1]));
for (const { base, var: v } of mountLines) {
  const file = `server/routes/${v.replace(/Router$/, '')}.js`;
  if (!fs.existsSync(file)) continue;
  for (const m of read(file).matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
    const sub = m[2] === '/' ? '' : m[2];
    serverPaths.add(`${base}${sub}`);
  }
}
const clientPaths = new Map();
for (const f of [...files, ...Object.values({})]) {
  const src = read(f);
  for (const m of src.matchAll(/api\.(?:get|post|patch|put|del)\(\s*[`']([^`'?${]+)/g)) {
    clientPaths.set(m[1].replace(/\$\{[^}]*\}/g, ':x'), [f, m[0]]);
  }
}
const badPaths = [];
for (const [p, [f, snippet]] of clientPaths) {
  const clean = p.replace(/:x/g, 'X');
  // Match by shape: replace :x with a wildcard segment.
  const shape = p.split('/').filter(Boolean);
  let found = false;
  for (const sp of serverPaths) {
    const sshape = sp.split('/').filter(Boolean);
    if (shape.length !== sshape.length) continue;
    let ok = true;
    for (let i = 0; i < shape.length; i += 1) {
      const a = shape[i];
      const b = sshape[i];
      if (b.startsWith(':')) continue;
      if (a === 'x') continue;
      if (a !== b) { ok = false; break; }
    }
    if (ok) { found = true; break; }
  }
  if (!found) badPaths.push(`${f}: ${clean} — no server route matches`);
}

/* 5 — identifiers that are called but never imported or declared ------------- */
const BUILTINS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'void', 'delete', 'in', 'of', 'do', 'else', 'try', 'super', 'import', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Promise', 'Set', 'Map', 'WeakMap', 'URL', 'URLSearchParams', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response', 'Error', 'TypeError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone', 'fetch', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'RegExp', 'Intl', 'Symbol', 'Reflect', 'console', 'document', 'window', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'caches', 'serviceWorker', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'alert', 'confirm', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'AbortController', 'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'NodeFilter', 'crypto', 'performance']);
const undefinedCalls = [];
for (const f of files) {
  const src = stripData(read(f));
  const declared = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) for (const p2 of m[1].split(',')) declared.add(p2.trim().split(/\s+as\s+/).pop().trim());
  for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) declared.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g)) declared.add(m[1]);
  // any destructuring pattern (params, options objects) declares its keys
  for (const m of src.matchAll(/\{([^{}]*)\}/g)) {
    for (const p2 of m[1].split(',')) {
      const name = p2.trim().split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z0-9_$]+$/.test(name)) declared.add(name);
    }
  }
  for (const m of src.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=/g)) for (const p2 of m[1].split(',')) declared.add(p2.trim().split(':').pop().split('=')[0].trim());
  for (const m of src.matchAll(/(?:\(|,|\s)\s*(?:async\s*)?\(?([A-Za-z0-9_$,\s{}]+)\)?\s*=>/g)) for (const p2 of m[1].split(',')) declared.add(p2.trim().replace(/[{}]/g, ''));
  for (const m of src.matchAll(/function\s*[A-Za-z0-9_$]*\s*\(([^)]*)\)/g)) for (const p2 of m[1].split(',')) declared.add(p2.trim().split('=')[0].trim());
  const calls = new Set();
  for (const m of src.matchAll(/(?<![.$\w])([a-z][A-Za-z0-9_$]*)\s*\(/g)) calls.add(m[1]);
  for (const name of calls) {
    if (!name || BUILTINS.has(name) || declared.has(name)) continue;
    if (/^(on|is|can|has|to|get|set|make|open|close|paint|load|run|render|view|constructor|async|only|value|go|props|options|state|args)$/.test(name)) continue;
    undefinedCalls.push(`${f}: ${name}()`);
  }
}

/* 6 — every class token a view paints must exist in the stylesheet ----------- */
const css = read('public/styles/app.css');
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
const unknownClasses = [];
for (const f of files) {
  if (!f.endsWith('.js')) continue;
  const src = strip(read(f));
  const tokens = new Map(); // class -> line
  const push = (raw, line) => {
    for (const tok of raw.split(/\s+/)) {
      const name = tok.trim();
      if (!/^[a-z][a-z0-9_-]{1,30}$/.test(name)) continue;
      if (/^(svg|div|span|p|form|input|button|img|table|tbody|thead|tr|td|th|auto|none|block|flex|grid|hidden|text|html|class|className|self|top|left|right|bottom|center|repeat|nowrap|nowrap|wrap|inherit|transparent|solid|dashed|dotted|both|forwards|infinite|linear|ease|easeinout|cubic|bezier|milliseconds|seconds)$/.test(name)) continue;
      if (!tokens.has(name)) tokens.set(name, line);
    }
  };
  const lines = src.split('\n');
  lines.forEach((lineSrc, i) => {
    for (const m of lineSrc.matchAll(/(?:class|className):\s*(['"`])([^'"`]*)\1/g)) push(m[2], i + 1);
    // only the quoted class arguments — not the second `toggle()` argument
    for (const m of lineSrc.matchAll(/classList\.(?:add|remove|toggle)\(\s*(['"`])([^'"`]*)\1/g)) push(m[2], i + 1);
    // template pieces: class: `btn ${x} ghost` → keep the literal fragments
    for (const m of lineSrc.matchAll(/(?:class|className):\s*`([^`]*)`/g)) {
      push(m[1].replace(/\$\{[^}]*\}/g, ' '), i + 1);
    }
  });
  for (const [name, line] of tokens) {
    if (cssClasses.has(name)) continue;
    if (name.startsWith('ico') || name.startsWith('tab-')) continue;
    unknownClasses.push(`${f}:${line} .${name}`);
  }
}

/* report ------------------------------------------------------------------- */
let bad = 0;
const dump = (title, list) => {
  if (!list.length) { console.log(`OK  ${title}`); return; }
  bad += list.length;
  console.log(`!!  ${title} (${list.length})`);
  for (const item of list) console.log(`     ${item}`);
};
dump('i18n keys', missingKeys.map(([k, w]) => `${k}  ← ${w}`));
dump('icons', missingIcons);
dump('imports', badImports);
dump('api paths', badPaths);
dump('identifiers', undefinedCalls);
dump('css classes', unknownClasses);
console.log(`\ndictionary has ${dictKeys.size} keys, client uses ${usedKeys.size}; unused (not an error): ${unusedKeys.length}`);
process.exit(bad ? 1 : 0);
