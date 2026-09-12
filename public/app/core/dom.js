/** Tiny hyperscript. All customer data is written with `h(...)` text nodes, so HTML strings never carry user input. */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props = null, ...children) {
  let el;
  if (typeof tag === 'string' && tag.startsWith('svg:')) {
    el = document.createElementNS(SVG_NS, tag.slice(4));
  } else {
    el = document.createElement(tag);
  }
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') el.setAttribute('class', value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'html') el.innerHTML = value; // static markup from this bundle only (icons)
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'ref' && typeof value === 'function') value(el);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value') el.value = String(value);
      else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') {
        el[key] = !!value;
        if (value) el.setAttribute(key, '');
        else el.removeAttribute(key);
      } else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/** Replace children in one paint so list updates do not flicker. */
export function render(node, ...children) {
  const frag = document.createDocumentFragment();
  append(frag, children);
  clear(node);
  node.appendChild(frag);
  return node;
}

export const byId = (id) => document.getElementById(id);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Debounce for search-as-you-type and quantity previews. */
export function debounce(fn, ms = 260) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const match = e.target.closest(selector);
    if (match && root.contains(match)) handler(e, match);
  });
}

export function lockScroll(locked) {
  document.body.style.overflow = locked ? 'hidden' : '';
}
