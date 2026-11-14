// Dominote UI. The DOM is the source of truth while editing; it is serialized to Markdown on save.
const { invoke } = window.__TAURI__.core;
const $ = s => document.querySelector(s);
const editor = $('#editor'), titleEl = $('#title'), treeEl = $('#tree');

const TEXT = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'quote', 'callout']);
const LIST = MD.LIST;
const ITEMS = [
  { type: 'p', label: 'Text', hint: '', keys: 'text paragraph plain' },
  { type: 'h1', label: 'Heading 1', hint: '#', keys: 'h1 heading title big' },
  { type: 'h2', label: 'Heading 2', hint: '##', keys: 'h2 heading subtitle' },
  { type: 'h3', label: 'Heading 3', hint: '###', keys: 'h3 heading small' },
  { type: 'ul', label: 'Bulleted list', hint: '-', keys: 'bullet list unordered ul' },
  { type: 'ol', label: 'Numbered list', hint: '1.', keys: 'numbered list ordered ol' },
  { type: 'todo', label: 'To-do list', hint: '[]', keys: 'todo task checkbox check' },
  { type: 'table', label: 'Table', hint: '', keys: 'table grid' },
  { type: 'code', label: 'Code', hint: '```', keys: 'code snippet pre' },
  { type: 'quote', label: 'Quote', hint: '>', keys: 'quote blockquote' },
  { type: 'callout', label: 'Callout', hint: '', keys: 'callout note info box' },
  { type: 'divider', label: 'Divider', hint: '---', keys: 'divider line hr separator' },
];
const SHORTCUTS = [[/^#\s/, 'h1'], [/^##\s/, 'h2'], [/^###\s/, 'h3'], [/^[-*+]\s/, 'ul'], [/^1[.)]\s/, 'ol'], [/^\[\s?\]\s/, 'todo'], [/^>\s/, 'quote']];

let current = null;      // open note path, relative to the notes root
let lastSaved = null;    // Markdown last read from / written to disk for `current`
let saveTimer = null, renameTimer = null;
let selectedDir = '';
let rootDir = '';
let treeJson = '';
let queue = Promise.resolve();
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const openDirs = new Set(store.get('openDirs', []));

// View preferences stay on this Mac, separate from Markdown content.
const pageViews = store.get('pageViews', {});
const pageView = $('#page-view');
function applyPageView() {
  const view = pageViews[current] || {};
  const zoom = [100, 90, 80, 70].includes(view.zoom) ? view.zoom : 100;
  $('#page').style.setProperty('--view-zoom', zoom / 100);
  $('#page').classList.toggle('full-width', view.wide === true);
  $('#view-wide').checked = view.wide === true;
  $('#view-zoom').value = zoom;
  pageView.hidden = !current;
  pageView.open = false;
}
pageView.addEventListener('change', () => {
  if (!current) return;
  pageViews[current] = { wide: $('#view-wide').checked, zoom: Number($('#view-zoom').value) };
  store.set('pageViews', pageViews);
  applyPageView();
});
document.addEventListener('pointerdown', e => {
  if (!pageView.contains(e.target)) pageView.open = false;
});
pageView.addEventListener('keydown', e => {
  if (e.key === 'Escape') { pageView.open = false; pageView.querySelector('summary').focus(); }
});
function remapPageViews(from, to) {
  for (const path of Object.keys(pageViews)) {
    if (path === from || path.startsWith(from + '/')) {
      pageViews[to + path.slice(from.length)] = pageViews[path];
      delete pageViews[path];
    }
  }
  store.set('pageViews', pageViews);
}

// ---------- helpers ----------
const base = p => p.split('/').pop().replace(/\.md$/, '');
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const content = b => b.querySelector('.content');
function toast(msg) {
  const t = $('#toast');
  t.textContent = String(msg);
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2600);
}
// Every disk operation runs in order, so saves, renames and reloads never interleave.
function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  const r = sel.getRangeAt(0), pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function rangeAt(el, start, end = start) {
  const r = document.createRange();
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0, node, started = false;
  while ((node = w.nextNode())) {
    const len = node.length;
    if (!started && start <= pos + len) { r.setStart(node, start - pos); started = true; }
    if (started && end <= pos + len) { r.setEnd(node, end - pos); return r; }
    pos += len;
  }
  r.selectNodeContents(el);
  r.collapse(false);
  return r;
}
function placeCaret(el, where) {
  el.focus();
  const len = el.textContent.length;
  const r = rangeAt(el, where === 'end' ? len : Math.min(where, len));
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
function atEdge(el, up) {
  if (!el.textContent) return true;
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const rect = sel.getRangeAt(0).getClientRects()[0];
  if (!rect) return up ? caretOffset(el) === 0 : caretOffset(el) === el.textContent.length;
  const er = el.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
  return up ? rect.top - er.top < lh * 0.7 : er.bottom - rect.bottom < lh * 0.7;
}
function cleanEmpty(el) { if (!el.textContent) el.innerHTML = ''; }

// ---------- inline HTML -> Markdown ----------
function wrap(t, m) {
  if (!t.trim()) return t;
  const lead = t.match(/^\s*/)[0], trail = t.match(/\s*$/)[0];
  return lead + m + t.trim() + m + trail;
}
function htmlToMd(node) {
  let s = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { s += n.nodeValue.replace(/ /g, ' ').replace(/\n/g, ' '); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.nodeName;
    if (tag === 'BR') { s += ' '; continue; }
    if (tag === 'CODE') { s += n.textContent ? '`' + n.textContent + '`' : ''; continue; }
    const inner = htmlToMd(n);
    if (tag === 'B' || tag === 'STRONG') s += wrap(inner, '**');
    else if (tag === 'I' || tag === 'EM') s += wrap(inner, '*');
    else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s += wrap(inner, '~~');
    else if (tag === 'A') s += inner ? `[${inner}](${n.getAttribute('href') || ''})` : '';
    else if (tag === 'DIV' || tag === 'P') s += (s ? ' ' : '') + inner;
    else s += inner;
  }
  return s;
}

// ---------- blocks ----------
function makeBlock(b) {
  const el = document.createElement('div');
  el.className = 'block';
  el.dataset.type = b.type;
  const indent = LIST.has(b.type) ? b.indent || 0 : 0;
  el.dataset.indent = indent;
  el.style.marginLeft = indent * 26 + 'px';

  if (TEXT.has(b.type)) {
    if (b.type === 'todo') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'check';
      cb.checked = !!b.checked;
      el.classList.toggle('done', cb.checked);
      el.append(cb);
    }
    if (b.type === 'callout') el.insertAdjacentHTML('beforeend', '<span class="callout-icon">💡</span>');
    const c = document.createElement('div');
    c.className = 'content';
    c.contentEditable = 'true';
    c.innerHTML = MD.inlineToHtml(b.text || '');
    el.append(c);
  } else if (b.type === 'code') {
    el.innerHTML = '<div class="code-bar"><input class="lang" placeholder="language" spellcheck="false" list="lang-list"><button class="copy" tabindex="-1">Copy</button></div>' +
      '<div class="code-wrap"><pre class="hl" aria-hidden="true"></pre></div>';
    el.querySelector('.lang').value = b.lang || '';
    const pre = document.createElement('pre');
    pre.className = 'content';
    pre.contentEditable = 'plaintext-only';
    pre.spellcheck = false;
    pre.setAttribute('autocorrect', 'off');
    pre.textContent = b.text || '';
    el.querySelector('.code-wrap').append(pre);
    highlight(el);
  } else if (b.type === 'table') {
    const rows = b.rows || [['', '', ''], ['', '', ''], ['', '', '']];
    const t = document.createElement('table');
    rows.forEach((r, ri) => {
      const tr = t.insertRow();
      r.forEach(c => {
        const cell = document.createElement(ri ? 'td' : 'th');
        cell.className = 'cell';
        cell.contentEditable = 'true';
        cell.innerHTML = MD.inlineToHtml(c);
        tr.append(cell);
      });
    });
    const wrapEl = document.createElement('div');
    wrapEl.className = 'table-wrap';
    wrapEl.append(t);
    el.append(wrapEl);
    el.insertAdjacentHTML('beforeend', '<div class="table-ctl">' +
      '<button data-op="row+" tabindex="-1">+ Row</button><button data-op="col+" tabindex="-1">+ Column</button>' +
      '<button data-op="row-" tabindex="-1">− Row</button><button data-op="col-" tabindex="-1">− Column</button>' +
      '<button data-op="del" tabindex="-1">Delete table</button></div>');
  } else if (b.type === 'divider') {
    el.tabIndex = 0;
    el.innerHTML = '<hr>';
  }
  return el;
}

// Syntax colors: the editable <pre> has transparent text and sits on top of a highlighted copy.
// This keeps the caret, selection and undo of a plain editable field.
function highlight(block) {
  const text = content(block).textContent;
  const langEl = block.querySelector('.lang');
  const lang = langEl.value.trim().toLowerCase();
  let html;
  try {
    if (lang && hljs.getLanguage(lang)) html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    else if (!lang && text.length < 20000) {
      const r = hljs.highlightAuto(text);
      html = r.value;
      langEl.placeholder = r.language && r.relevance > 4 ? r.language + ' (auto)' : 'language';
    }
  } catch {}
  block.querySelector('.hl').innerHTML = (html ?? MD.esc(text)) + '\n';
}

function readBlock(el) {
  const type = el.dataset.type, indent = +el.dataset.indent || 0;
  if (TEXT.has(type)) return { type, indent, text: htmlToMd(content(el)).trim(), checked: el.querySelector('.check')?.checked };
  if (type === 'code') return { type, lang: el.querySelector('.lang').value.trim(), text: content(el).innerText.replace(/\n$/, '') };
  if (type === 'table') return { type, rows: [...el.querySelectorAll('tr')].map(tr => [...tr.cells].map(c => htmlToMd(c).trim())) };
  return { type };
}

function focusBlock(b, where) {
  if (!b) return;
  if (b.dataset.type === 'divider') return b.focus();
  if (b.dataset.type === 'table') {
    const cells = b.querySelectorAll('.cell');
    return placeCaret(where === 'end' ? cells[cells.length - 1] : cells[0], where);
  }
  placeCaret(content(b), where);
}

function renumber() {
  const counters = [];
  for (const b of editor.children) {
    const t = b.dataset.type, lvl = +b.dataset.indent || 0;
    if (t === 'ol') {
      counters.length = lvl + 1;
      b.dataset.num = counters[lvl] = (counters[lvl] || 0) + 1;
    } else if (!LIST.has(t)) counters.length = 0;
  }
}

function changed() {
  scheduleSave();
  clearTimeout(snapTimer);
  snapTimer = setTimeout(snapshot, 600);
}

// Replace a block with one of another type; returns the new block.
function setType(block, type, caret = 0) {
  const old = readBlock(block);
  let nb;
  if (type === 'divider') {
    nb = makeBlock({ type });
    const after = makeBlock({ type: 'p', text: old.text || '' });
    block.replaceWith(nb, after);
    focusBlock(after, 0);
  } else if (type === 'table') {
    nb = makeBlock({ type });
    block.replaceWith(nb);
    if (old.text) nb.before(makeBlock({ type: 'p', text: old.text }));
    focusBlock(nb, 0);
  } else if (type === 'code') {
    nb = makeBlock({ type, text: old.type === 'table' ? '' : old.text || '' });
    block.replaceWith(nb);
    placeCaret(content(nb), 'end');
  } else {
    const text = old.type === 'code' ? (old.text || '').replace(/\n/g, ' ') : old.text || '';
    nb = makeBlock({ type, text, indent: old.indent, checked: false });
    block.replaceWith(nb);
    placeCaret(content(nb), caret);
  }
  renumber();
  changed();
  return nb;
}

function insertAfter(block, type) {
  const nb = makeBlock({ type });
  block.after(nb);
  if (type === 'divider') {
    const p = makeBlock({ type: 'p' });
    nb.after(p);
    focusBlock(p, 0);
  } else focusBlock(nb, 0);
  renumber();
  changed();
  return nb;
}

function setIndent(block, n) {
  if (!LIST.has(block.dataset.type)) return;
  n = Math.max(0, Math.min(6, n));
  block.dataset.indent = n;
  block.style.marginLeft = n * 26 + 'px';
  renumber();
  changed();
}

function splitBlock(block) {
  const c = content(block), type = block.dataset.type;
  if (LIST.has(type) && !c.textContent.trim()) {
    if (+block.dataset.indent > 0) setIndent(block, +block.dataset.indent - 1);
    else setType(block, 'p');
    return;
  }
  const nextType = LIST.has(type) ? type : 'p';
  if (caretOffset(c) === 0 && c.textContent) {
    // Enter at the very start: open an empty line above, keep the caret where it is.
    block.before(makeBlock({ type: LIST.has(type) ? type : 'p', indent: +block.dataset.indent }));
    renumber();
    changed();
    return;
  }
  const r = getSelection().getRangeAt(0);
  r.deleteContents();
  const tail = document.createRange();
  tail.setStart(r.startContainer, r.startOffset);
  tail.setEnd(c, c.childNodes.length);
  const frag = tail.extractContents();
  const nb = makeBlock({ type: nextType, indent: +block.dataset.indent });
  content(nb).append(frag);
  cleanEmpty(c);
  cleanEmpty(content(nb));
  block.after(nb);
  placeCaret(content(nb), 0);
  renumber();
  changed();
}

function backspaceAtStart(block) {
  const type = block.dataset.type, c = content(block);
  if (type !== 'p') {
    if (LIST.has(type) && +block.dataset.indent > 0) setIndent(block, +block.dataset.indent - 1);
    else setType(block, 'p');
    return;
  }
  const prev = block.previousElementSibling;
  if (!prev) return;
  if (prev.dataset.type === 'divider') { prev.remove(); changed(); return; }
  if (TEXT.has(prev.dataset.type)) {
    const pc = content(prev), len = pc.textContent.length;
    cleanEmpty(pc);
    while (c.firstChild) pc.append(c.firstChild);
    block.remove();
    placeCaret(pc, len);
  } else {
    if (!c.textContent) block.remove();
    focusBlock(prev, 'end');
  }
  renumber();
  changed();
}

function moveBlock(block, up) {
  const sib = up ? block.previousElementSibling : block.nextElementSibling;
  if (!sib) return;
  const sel = getSelection(), r = sel.rangeCount ? sel.getRangeAt(0) : null;
  up ? sib.before(block) : sib.after(block);
  if (r) { sel.removeAllRanges(); sel.addRange(r); }
  renumber();
  changed();
}

function tableOp(block, op, cell) {
  const { rows } = readBlock(block);
  const ri = cell ? cell.parentElement.rowIndex : rows.length - 1;
  const ci = cell ? cell.cellIndex : rows[0].length - 1;
  if (op === 'del') {
    const p = makeBlock({ type: 'p' });
    block.replaceWith(p);
    focusBlock(p, 0);
    changed();
    return;
  }
  if (op === 'row+') rows.splice(ri + 1, 0, rows[0].map(() => ''));
  if (op === 'col+') rows.forEach(r => r.splice(ci + 1, 0, ''));
  if (op === 'row-' && rows.length > 1) rows.splice(ri, 1);
  if (op === 'col-' && rows[0].length > 1) rows.forEach(r => r.splice(ci, 1));
  const nb = makeBlock({ type: 'table', rows });
  block.replaceWith(nb);
  const t = nb.querySelector('table');
  const r2 = Math.min(op === 'row+' ? ri + 1 : ri, t.rows.length - 1);
  const c2 = Math.min(op === 'col+' ? ci + 1 : ci, t.rows[0].cells.length - 1);
  placeCaret(t.rows[r2].cells[c2], 0);
  changed();
}

// ---------- slash menu ----------
const slashEl = $('#slash');
let slash = null; // { block, el, start, items, index }

function openSlash(block, el, start) {
  slash = { block, el, start, items: ITEMS, index: 0 };
  renderSlash();
}
function closeSlash() { slash = null; slashEl.hidden = true; }
function renderSlash() {
  const q = slash.el.textContent.slice(slash.start + 1, caretOffset(slash.el)).toLowerCase().trim();
  slash.items = ITEMS.filter(i => !q || i.label.toLowerCase().includes(q) || i.keys.includes(q));
  if (!slash.items.length) return closeSlash();
  slash.index = Math.min(slash.index, slash.items.length - 1);
  slashEl.innerHTML = slash.items.map((it, i) =>
    `<div class="popup-item${i === slash.index ? ' sel' : ''}" data-i="${i}"><span>${it.label}</span><span class="hint">${it.hint}</span></div>`).join('');
  const r = getSelection().getRangeAt(0).getClientRects()[0] || slash.el.getBoundingClientRect();
  slashEl.hidden = false;
  const below = r.bottom + 6 + slashEl.offsetHeight < innerHeight;
  slashEl.style.left = Math.min(r.left, innerWidth - slashEl.offsetWidth - 8) + 'px';
  slashEl.style.top = (below ? r.bottom + 6 : r.top - slashEl.offsetHeight - 6) + 'px';
  slashEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function applySlash(i) {
  const { block, el, start } = slash;
  const item = slash.items[i];
  const end = caretOffset(el);
  closeSlash();
  rangeAt(el, start, Math.max(end, start + 1)).deleteContents();
  cleanEmpty(el);
  if (!el.textContent.trim()) setType(block, item.type);
  else insertAfter(block, item.type);
}
function slashKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = slash.items.length;
    slash.index = (slash.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderSlash();
  } else if (e.key === 'Enter' || e.key === 'Tab') applySlash(slash.index);
  else if (e.key === 'Escape') closeSlash();
  else return false;
  e.preventDefault();
  return true;
}
slashEl.addEventListener('mousedown', e => {
  e.preventDefault();
  const it = e.target.closest('.popup-item');
  if (it) applySlash(+it.dataset.i);
});

// ---------- editor events ----------
editor.addEventListener('keydown', e => {
  if (slash && slashKey(e)) return;
  const block = e.target.closest('.block');
  if (!block) return;
  const type = block.dataset.type;
  const mod = e.metaKey || e.ctrlKey;

  // Cmd+A: first selects the block's text, a second press selects every block.
  if (mod && !e.shiftKey && e.key === 'a') {
    const field = e.target.closest('.content, .cell');
    const sel = getSelection();
    if (field && (!field.textContent || sel.toString().length >= field.textContent.length)) {
      e.preventDefault();
      selectBlocks(editor.firstElementChild, editor.lastElementChild);
    }
    return;
  }
  if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    return moveBlock(block, e.key === 'ArrowUp');
  }

  if (e.target.classList.contains('lang')) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); placeCaret(content(block), 0); }
    return;
  }

  if (type === 'divider') {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const prev = block.previousElementSibling, next = block.nextElementSibling;
      block.remove();
      prev ? focusBlock(prev, 'end') : focusBlock(next, 0);
      changed();
    } else if (e.key === 'Enter') { e.preventDefault(); insertAfter(block, 'p'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusBlock(block.previousElementSibling, 'end'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusBlock(block.nextElementSibling, 0); }
    return;
  }

  if (type === 'code') {
    const pre = content(block);
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    else if (e.key === 'Escape' || (mod && e.key === 'Enter')) {
      e.preventDefault();
      const next = block.nextElementSibling;
      next && TEXT.has(next.dataset.type) ? focusBlock(next, 0) : insertAfter(block, 'p');
    } else if (e.key === 'Backspace' && !pre.textContent) { e.preventDefault(); setType(block, 'p'); }
    else if (e.key === 'ArrowUp' && caretOffset(pre) === 0 && block.previousElementSibling) { e.preventDefault(); focusBlock(block.previousElementSibling, 'end'); }
    else if (e.key === 'ArrowDown' && caretOffset(pre) === pre.textContent.length && block.nextElementSibling) { e.preventDefault(); focusBlock(block.nextElementSibling, 0); }
    return;
  }

  if (type === 'table') {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const cells = [...block.querySelectorAll('.cell')];
    const i = cells.indexOf(cell);
    const t = block.querySelector('table');
    const ri = cell.parentElement.rowIndex, ci = cell.cellIndex;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) { if (i > 0) placeCaret(cells[i - 1], 'end'); }
      else if (i < cells.length - 1) placeCaret(cells[i + 1], 'end');
      else tableOp(block, 'row+', cell);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (mod) insertAfter(block, 'p');
      else if (ri < t.rows.length - 1) placeCaret(t.rows[ri + 1].cells[ci], 'end');
      else tableOp(block, 'row+', cell);
    } else if (e.key === 'Escape') { e.preventDefault(); insertAfter(block, 'p'); }
    else if (e.key === 'ArrowUp' && atEdge(cell, true)) {
      e.preventDefault();
      ri > 0 ? placeCaret(t.rows[ri - 1].cells[ci], 'end') : focusBlock(block.previousElementSibling, 'end');
    } else if (e.key === 'ArrowDown' && atEdge(cell, false)) {
      e.preventDefault();
      ri < t.rows.length - 1 ? placeCaret(t.rows[ri + 1].cells[ci], 'end') : focusBlock(block.nextElementSibling, 0);
    }
    return;
  }

  // Text blocks
  const c = content(block);
  if (mod && !e.shiftKey && e.key === 'b') { e.preventDefault(); document.execCommand('bold'); return; }
  if (mod && !e.shiftKey && e.key === 'i') { e.preventDefault(); document.execCommand('italic'); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); document.execCommand('strikeThrough'); return; }
  if (mod && !e.shiftKey && e.key === 'e') { e.preventDefault(); toggleInlineCode(c); return; }

  if (e.key === 'Enter') { e.preventDefault(); splitBlock(block); return; }
  if (e.key === 'Backspace' && getSelection().isCollapsed && caretOffset(c) === 0) { e.preventDefault(); backspaceAtStart(block); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    setIndent(block, +block.dataset.indent + (e.shiftKey ? -1 : 1));
    return;
  }
  if (e.key === 'ArrowUp' && !e.shiftKey && atEdge(c, true) && block.previousElementSibling) { e.preventDefault(); focusBlock(block.previousElementSibling, 'end'); }
  if (e.key === 'ArrowDown' && !e.shiftKey && atEdge(c, false) && block.nextElementSibling) { e.preventDefault(); focusBlock(block.nextElementSibling, 0); }
});

function toggleInlineCode(c) {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const existing = r.commonAncestorContainer.parentElement?.closest('code');
  if (existing && c.contains(existing)) { existing.replaceWith(existing.textContent); changed(); return; }
  if (r.collapsed) return;
  const code = document.createElement('code');
  code.textContent = r.toString();
  r.deleteContents();
  r.insertNode(code);
  sel.removeAllRanges();
  const after = document.createRange();
  after.setStartAfter(code);
  sel.addRange(after);
  changed();
}

editor.addEventListener('input', e => {
  const block = e.target.closest('.block');
  if (!block) return;
  const type = block.dataset.type;
  const c = e.target.closest('.content');
  if (type === 'code') highlight(block);
  if (c && TEXT.has(type)) {
    if (c.innerHTML === '<br>') c.innerHTML = '';
    const text = c.textContent.replace(/ /g, ' ');
    const off = caretOffset(c);

    if (type === 'p') {
      for (const [re, t] of SHORTCUTS) {
        const m = text.match(re);
        if (m && off === m[0].length) {
          rangeAt(c, 0, m[0].length).deleteContents();
          setType(block, t, 0);
          return;
        }
      }
      if (text === '```') { c.textContent = ''; setType(block, 'code'); return; }
      if (text === '---') { c.textContent = ''; setType(block, 'divider'); return; }
    }

    if (slash) {
      if (slash.el !== c || off <= slash.start || text[slash.start] !== '/') closeSlash();
      else renderSlash();
    } else if (text[off - 1] === '/' && (off === 1 || /\s/.test(text[off - 2]))) {
      openSlash(block, c, off - 1);
    }
  }
  changed();
});

// Edit > Undo from the menu bar goes through the same page history as ⌘Z.
editor.addEventListener('beforeinput', e => {
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
    e.preventDefault();
    undo(e.inputType === 'historyUndo' ? -1 : 1);
  } else if (snapTimer && e.inputType === 'insertText' && e.data === ' ') snapshot(); // one undo step per word
});
// Moving to another block or table cell starts a new undo step.
editor.addEventListener('focusin', () => { if (snapTimer) snapshot(); });

editor.addEventListener('change', e => {
  if (e.target.classList.contains('check')) {
    e.target.closest('.block').classList.toggle('done', e.target.checked);
    changed();
  }
});

editor.addEventListener('mousedown', e => {
  const btn = e.target.closest('.table-ctl button, .copy');
  if (!btn) return;
  e.preventDefault();
  const block = btn.closest('.block');
  if (btn.classList.contains('copy')) {
    navigator.clipboard.writeText(content(block).innerText).then(() => toast('Copied'));
    return;
  }
  const cell = block.contains(document.activeElement) && document.activeElement.closest('.cell');
  tableOp(block, btn.dataset.op, cell || null);
});

// ---------- block selection ----------
// Each block is its own editable field, so native text selection cannot cross blocks.
// Dragging out of the starting block switches to selecting whole blocks instead.
let dragAnchor = null, selBlocks = [];
function clearBlockSel() {
  selBlocks.forEach(b => b.classList.remove('selected'));
  selBlocks = [];
}
function selectBlocks(a, b) {
  clearBlockSel();
  const all = [...editor.children];
  let i = all.indexOf(a), j = all.indexOf(b);
  if (i < 0 || j < 0) return;
  if (i > j) [i, j] = [j, i];
  selBlocks = all.slice(i, j + 1);
  selBlocks.forEach(x => x.classList.add('selected'));
  getSelection().removeAllRanges();
  document.activeElement?.blur();
}
function blockAtY(y) {
  for (const b of editor.children) if (y < b.getBoundingClientRect().bottom) return b;
  return editor.lastElementChild;
}
function deleteSelectedBlocks() {
  const next = selBlocks[selBlocks.length - 1].nextElementSibling || selBlocks[0].previousElementSibling;
  selBlocks.forEach(b => b.remove());
  selBlocks = [];
  if (!editor.children.length) editor.append(makeBlock({ type: 'p' }));
  focusBlock(next && next.isConnected ? next : editor.firstElementChild, 0);
  renumber();
  changed();
}
function copySelectedBlocks() {
  const md = MD.serialize(selBlocks.map(readBlock));
  return navigator.clipboard.writeText(md).then(() => toast(`Copied ${selBlocks.length} block${selBlocks.length > 1 ? 's' : ''}`));
}
editor.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  clearBlockSel();
  dragAnchor = e.target.closest('.table-ctl, .code-bar') ? null : e.target.closest('.block');
});
document.addEventListener('mousemove', e => {
  if (!dragAnchor || !(e.buttons & 1)) return;
  const b = blockAtY(e.clientY);
  if (b === dragAnchor && !selBlocks.length) return;
  selectBlocks(dragAnchor, b);
  // Scroll while dragging near the top or bottom edge.
  const main = $('#main'), r = main.getBoundingClientRect();
  if (e.clientY < r.top + 40) main.scrollTop -= 14;
  else if (e.clientY > r.bottom - 40) main.scrollTop += 14;
});
document.addEventListener('mouseup', () => { dragAnchor = null; });
document.addEventListener('mousedown', e => { if (!editor.contains(e.target)) clearBlockSel(); });
document.addEventListener('keydown', e => {
  if (!selBlocks.length) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelectedBlocks(); }
  else if (mod && k === 'c') { e.preventDefault(); copySelectedBlocks(); }
  else if (mod && k === 'x') { e.preventDefault(); copySelectedBlocks().then(deleteSelectedBlocks); }
  else if (e.key === 'Escape') clearBlockSel();
  else if (!mod && e.key.length === 1) clearBlockSel();
}, true);

// Rich paste (from Claude, browsers, Notion, Google Docs): convert HTML structure into blocks.
const INLINE_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'CODE', 'A', 'SPAN', 'S', 'DEL', 'STRIKE', 'U', 'BR', 'MARK', 'SUB', 'SUP', 'SMALL', 'LABEL', 'FONT']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'BUTTON', 'svg', 'SVG', 'IMG', 'TEMPLATE', 'NOSCRIPT']);
function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  const inline = el => htmlToMd(el).replace(/\s+/g, ' ').trim();
  function list(el, indent) {
    for (const li of el.children) {
      if (li.nodeName !== 'LI') continue;
      const c = li.cloneNode(true);
      c.querySelectorAll('ul, ol').forEach(n => n.remove());
      const cb = c.querySelector('input[type="checkbox"]');
      cb?.remove();
      const text = inline(c);
      if (cb) out.push({ type: 'todo', checked: cb.hasAttribute('checked'), text, indent });
      else out.push({ type: el.nodeName === 'OL' ? 'ol' : 'ul', text, indent });
      for (const sub of li.querySelectorAll(':scope > ul, :scope > ol')) list(sub, Math.min(6, indent + 1));
    }
  }
  function walk(parent) {
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const d = document.createElement('div');
      buf.forEach(n => d.append(n.cloneNode(true)));
      const t = inline(d);
      if (t) out.push({ type: 'p', text: t });
      buf = [];
    };
    for (const n of parent.childNodes) {
      const tag = n.nodeName;
      if (n.nodeType === 3 || INLINE_TAGS.has(tag)) { buf.push(n); continue; }
      if (n.nodeType !== 1 || SKIP_TAGS.has(tag)) continue;
      flush();
      if (/^H[1-6]$/.test(tag)) {
        const t = inline(n).replace(/^\*\*(.*)\*\*$/, '$1');
        if (t) out.push({ type: 'h' + Math.min(3, +tag[1]), text: t });
      } else if (tag === 'P') {
        const t = inline(n);
        if (t) out.push({ type: 'p', text: t });
      } else if (tag === 'UL' || tag === 'OL') list(n, 0);
      else if (tag === 'PRE') {
        const lang = (n.querySelector('code')?.className.match(/language-([\w+#-]+)/) || [])[1] || '';
        out.push({ type: 'code', lang, text: n.textContent.replace(/\n$/, '') });
      } else if (tag === 'BLOCKQUOTE') {
        const t = inline(n);
        if (t) out.push({ type: 'quote', text: t });
      } else if (tag === 'TABLE') {
        const rows = [...n.rows].map(tr => [...tr.cells].map(c => inline(c)));
        if (!rows.length) continue;
        const w = Math.max(...rows.map(r => r.length));
        rows.forEach(r => { while (r.length < w) r.push(''); });
        out.push({ type: 'table', rows });
      } else if (tag === 'HR') out.push({ type: 'divider' });
      else walk(n);
    }
    flush();
  }
  walk(doc.body);
  return out;
}

function insertBlocks(block, blocks) {
  const els = blocks.map(makeBlock);
  if (!els.length) return;
  if (TEXT.has(block.dataset.type) && !content(block).textContent.trim()) block.replaceWith(...els);
  else block.after(...els);
  focusBlock(els[els.length - 1], 'end');
  renumber();
  changed();
}

editor.addEventListener('paste', e => {
  const block = e.target.closest('.block');
  if (!block) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  const html = e.clipboardData.getData('text/html');
  const plain = block.dataset.type === 'code' || e.target.classList.contains('lang');
  const cell = e.target.closest('.cell');
  if (html && !plain) {
    const blocks = htmlToBlocks(html);
    const single = blocks.length === 1 && blocks[0].type === 'p';
    // One paragraph (or any paste into a table cell) goes inline, keeping bold, links and code.
    if (single || (cell && blocks.length)) {
      const t = cell ? blocks.map(b => b.text || (b.rows || []).flat().join(' ')).join(' ') : blocks[0].text;
      document.execCommand('insertHTML', false, MD.inlineToHtml(t));
      return;
    }
    if (blocks.length) return insertBlocks(block, blocks);
  }
  if (!text) return;
  if (plain || !text.includes('\n') || cell) {
    document.execCommand('insertText', false, plain ? text : text.replace(/\s*\n\s*/g, ' '));
    return;
  }
  // Multi-line plain text: treat it as Markdown.
  insertBlocks(block, MD.parse(text));
});

// Click on the empty area below the blocks: continue writing at the end.
$('#page').addEventListener('mousedown', e => {
  if (e.target !== $('#page') && e.target !== editor) return;
  if (e.clientY < editor.getBoundingClientRect().bottom) return;
  e.preventDefault();
  const last = editor.lastElementChild;
  if (last && last.dataset.type === 'p' && !content(last).textContent) focusBlock(last, 0);
  else insertAfter(last || editor.appendChild(makeBlock({ type: 'p' })), 'p');
});

document.addEventListener('selectionchange', () => {
  if (slash && !slash.el.contains(getSelection().anchorNode)) closeSlash();
});

// ---------- title ----------
titleEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    let first = editor.firstElementChild;
    if (!first) editor.append((first = makeBlock({ type: 'p' })));
    focusBlock(first, 0);
  }
});
titleEl.addEventListener('input', () => {
  clearTimeout(renameTimer);
  renameTimer = setTimeout(renameCurrent, 700);
});
titleEl.addEventListener('blur', () => { if (renameTimer) renameCurrent(); });
titleEl.addEventListener('paste', e => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' '));
});

function renameCurrent() {
  clearTimeout(renameTimer);
  renameTimer = null;
  return enqueue(async () => {
    const name = titleEl.textContent.trim();
    if (!current || !name || name === base(current)) return;
    try {
      const np = await invoke('rename', { path: current, name });
      remapPageViews(current, np);
      current = np;
      store.set('last', current);
      showCrumbs();
      await refreshTree(true);
    } catch (err) { toast(err); }
  });
}

// ---------- notes ----------
function serializeDoc() { return MD.serialize([...editor.children].map(readBlock)); }
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return enqueue(async () => {
    if (!current) return;
    const md = serializeDoc();
    if (md === lastSaved) return;
    await invoke('write_note', { path: current, content: md });
    lastSaved = md;
  }).catch(err => toast('Save failed: ' + err));
}
async function flush() {
  snapshot();
  await saveSketch();
  if (renameTimer) await renameCurrent();
  await save();
}

// ---------- undo ----------
// Native undo only sees typing inside one field. It can't follow block splits, merges,
// table edits, pasted blocks or a reload, so the app keeps whole-page snapshots instead.
// One history per page, kept while the app runs, so switching pages doesn't lose it.
const histories = new Map(); // path -> { states: [{ md, at }], i }
let snapTimer = null;
function focusedIndex() {
  const b = document.activeElement?.closest?.('#editor > .block');
  return b ? [...editor.children].indexOf(b) : -1;
}
function snapshot() {
  clearTimeout(snapTimer);
  snapTimer = null;
  if (!current) return;
  const md = serializeDoc();
  let h = histories.get(current);
  if (!h) return histories.set(current, { states: [{ md, at: focusedIndex() }], i: 0 });
  if (md === h.states[h.i].md) return;
  h.states.length = h.i + 1;
  h.states.push({ md, at: focusedIndex() });
  if (h.states.length > 500) h.states.shift();
  h.i = h.states.length - 1;
}
function undo(step) {
  snapshot();
  const h = histories.get(current);
  const j = h ? h.i + step : -1;
  if (j < 0 || j >= h.states.length) return;
  // Put the caret where the undone (or redone) change happened.
  const at = h.states[step < 0 ? h.i : j].at;
  h.i = j;
  render(h.states[j].md);
  const n = editor.children.length;
  focusBlock(editor.children[Math.min(Math.max(at, 0), n - 1)], 'end');
  scheduleSave();
}

function render(md) {
  editor.replaceChildren(...MD.parse(md).map(makeBlock));
  if (!editor.children.length) editor.append(makeBlock({ type: 'p' }));
  renumber();
}
function showCrumbs() {
  const d = dirOf(current || '');
  $('#crumbs').textContent = d ? d.split('/').join(' / ') : '';
}
function showEmpty() {
  closeSketch(false);
  current = null;
  lastSaved = null;
  $('#page').hidden = true;
  applyPageView();
  store.set('last', null);
  markActive();
}

async function openNote(path, { focusTitle = false } = {}) {
  if (isSketch(path)) return openSketch(path);
  await flush();
  await closeSketch();
  closeSlash();
  let md;
  try { md = await invoke('read_note', { path }); } catch (err) { toast(err); return; }
  current = path;
  applyPageView();
  lastSaved = md;
  selectedDir = dirOf(path);
  store.set('last', path);
  titleEl.textContent = base(path);
  showCrumbs();
  render(md);
  snapshot();
  $('#page').hidden = false;
  $('#main').scrollTop = 0;
  expandTo(path);
  markActive();
  if (focusTitle) {
    titleEl.focus();
    getSelection().selectAllChildren(titleEl);
  } else if (!editor.textContent.trim()) focusBlock(editor.firstElementChild, 0);
}

async function newNote(dir = selectedDir) {
  if (inSketches(dir)) dir = '';
  await flush();
  try {
    const path = await invoke('create_note', { dir });
    await refreshTree(true);
    await openNote(path, { focusTitle: true });
  } catch (err) { toast(err); }
}
async function newSketch(dir = inSketches(selectedDir) ? selectedDir : SKETCHES) {
  await flush();
  try {
    const path = await invoke('create_note', { dir, sketch: true });
    if (dir !== SKETCHES) openDirs.add(dir);
    await refreshTree(true);
    await openNote(path);
    startRename(path);
  } catch (err) { toast(err); }
}
async function newFolder(dir = selectedDir) {
  try {
    const path = await invoke('create_folder', { dir });
    if (dir) openDirs.add(dir);
    await refreshTree(true);
    startRename(path);
  } catch (err) { toast(err); }
}

// Keep the open note pointed at the right file after its folder or itself moves.
function remap(from, to) {
  remapPageViews(from, to);
  for (const [k, h] of [...histories]) {
    if (k === from || k.startsWith(from + '/')) { histories.delete(k); histories.set(to + k.slice(from.length), h); }
  }
  if (sketchPath && (sketchPath === from || sketchPath.startsWith(from + '/'))) {
    sketchPath = to + sketchPath.slice(from.length);
    store.set('last', sketchPath);
  }
  if (!current) return;
  if (current === from) current = to;
  else if (current.startsWith(from + '/')) current = to + current.slice(from.length);
  else return;
  store.set('last', current);
  titleEl.textContent = base(current);
  showCrumbs();
}

// ---------- sketches ----------
// Whiteboards are Excalidraw files under Sketches/. The Excalidraw bundle (ui/sketch, built from
// sketch/) is loaded the first time a sketch opens, so notes start as fast as before.
const SKETCHES = 'Sketches';
const isSketch = p => p.endsWith('.excalidraw');
const inSketches = p => p === SKETCHES || p.startsWith(SKETCHES + '/');
const sketchEl = $('#sketch');
let sketch = null, sketchPath = null, sketchSaved = null, sketchTimer = null, sketchLib = null;
function loadSketchLib() {
  if (!sketchLib) {
    window.EXCALIDRAW_ASSET_PATH = new URL('sketch/', location.href).href;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'sketch/main.css';
    document.head.append(css);
    sketchLib = import('./sketch/main.js').catch(err => { sketchLib = null; throw err; });
  }
  return sketchLib;
}
const themeNow = () => settings.theme !== 'system' ? settings.theme
  : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

async function openSketch(path) {
  await flush();
  let json;
  try { json = await invoke('read_note', { path }); } catch (err) { toast(err); return; }
  await closeSketch();
  closeSlash();
  current = null;
  lastSaved = null;
  $('#page').hidden = true;
  applyPageView();
  document.body.classList.add('sketching');
  sketchEl.hidden = false;
  sketchPath = path;
  sketchSaved = json;
  selectedDir = dirOf(path);
  store.set('last', path);
  expandTo(path);
  markActive();
  let lib;
  try { lib = await loadSketchLib(); } catch (err) { toast('Could not load the whiteboard: ' + err); return; }
  if (sketchPath !== path || sketch) return; // another file was opened while loading
  sketch = lib.mount(sketchEl, {
    json,
    theme: themeNow(),
    onChange: () => { clearTimeout(sketchTimer); sketchTimer = setTimeout(saveSketch, 400); },
  });
}
function saveSketch() {
  clearTimeout(sketchTimer);
  sketchTimer = null;
  const path = sketchPath, json = sketch?.json();
  if (!path || !json || json === sketchSaved) return Promise.resolve();
  sketchSaved = json;
  return enqueue(() => invoke('write_note', { path, content: json })).catch(err => toast('Save failed: ' + err));
}
// save=false when the file is gone (trashed or deleted outside the app), so it isn't written back.
async function closeSketch(save = true) {
  if (sketch) {
    if (save) await saveSketch();
    sketch.unmount();
    sketch = null;
  }
  clearTimeout(sketchTimer);
  sketchTimer = null;
  sketchPath = sketchSaved = null;
  sketchEl.hidden = true;
  document.body.classList.remove('sketching');
}
// Presenting: full screen without the sidebar. Works for notes and sketches.
// Export as PDF: the macOS print dialog has a PDF button. Print CSS shows only the page.
async function exportPdf(path = current) {
  if (!path || isSketch(path)) return toast('Open a page to export it');
  if (path !== current) await openNote(path);
  await flush();
  invoke('print_page', { title: base(path) }).catch(toast);
}

async function togglePresent() {
  const win = window.__TAURI__.window.getCurrentWindow();
  try {
    const full = !(await win.isFullscreen());
    await win.setFullscreen(full);
    document.body.classList.toggle('no-sidebar', full);
  } catch (err) { toast(err); }
}

// ---------- tree ----------
const ICON_PAGE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/></svg>';
const ICON_SKETCH = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 14l1-4 8-8 3 3-8 8z"/><path d="M9.5 3.5l3 3"/></svg>';
const ICON_LINK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z"/><path d="M6.5 11.5l3.5-3.5M7.5 8h2.5v2.5"/></svg>';
const ICON_FOLDER = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z"/></svg>';

async function refreshTree(force) {
  if (treeEl.querySelector('input')) return; // don't clobber an inline rename
  const nodes = await invoke('tree');
  const json = JSON.stringify(nodes);
  if (!force && json === treeJson) return;
  treeJson = json;
  treeEl.replaceChildren();
  const sk = nodes.find(n => n.dir && n.path === SKETCHES);
  const notes = nodes.filter(n => n !== sk);
  const emptyRow = text => Object.assign(document.createElement('div'), { className: 'empty-tree', textContent: text });
  treeEl.append(sectionRow('Notes', ''));
  if (!notes.length) treeEl.append(emptyRow('No pages yet'));
  renderNodes(notes, treeEl, 0);
  treeEl.append(sectionRow('Sketches', SKETCHES));
  if (!sk?.children.length) treeEl.append(emptyRow('No sketches yet'));
  renderNodes(sk?.children || [], treeEl, 0);
  markActive();
}
// Section headers act as drop targets: Notes for the top level, Sketches for the Sketches folder.
function sectionRow(label, path) {
  const row = document.createElement('div');
  row.className = 'item section';
  row.dataset.path = path;
  row.dataset.dir = path ? '1' : '';
  row.dataset.section = '1';
  row.textContent = label;
  return row;
}
function renderNodes(nodes, parent, depth) {
  for (const n of nodes) {
    const row = document.createElement('div');
    row.className = 'item';
    row.dataset.path = n.path;
    row.dataset.dir = n.dir ? '1' : '';
    if (n.link) { row.dataset.link = '1'; row.title = 'Linked folder'; }
    row.draggable = true;
    row.style.paddingLeft = depth * 14 + 4 + 'px';
    const isOpen = openDirs.has(n.path);
    row.innerHTML = `<span class="twisty">${n.dir ? (isOpen ? '▼' : '▶') : ''}</span><span class="icon">${n.link ? ICON_LINK : n.dir ? ICON_FOLDER : isSketch(n.path) ? ICON_SKETCH : ICON_PAGE}</span><span class="label"></span>`;
    row.querySelector('.label').textContent = n.name;
    parent.append(row);
    if (n.dir && isOpen) {
      if (!n.children.length) {
        const e = document.createElement('div');
        e.className = 'empty-tree';
        e.style.paddingLeft = (depth + 1) * 14 + 26 + 'px';
        e.textContent = 'Empty';
        parent.append(e);
      }
      renderNodes(n.children, parent, depth + 1);
    }
  }
}
function markActive() {
  const open = current || sketchPath;
  for (const el of treeEl.querySelectorAll('.item')) el.classList.toggle('active', el.dataset.path === open);
}
function expandTo(path) {
  const parts = path.split('/');
  let changedDirs = false;
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    if (!openDirs.has(d)) { openDirs.add(d); changedDirs = true; }
  }
  if (changedDirs) { store.set('openDirs', [...openDirs]); refreshTree(true); }
}

treeEl.addEventListener('click', e => {
  const row = e.target.closest('.item');
  if (!row || row.dataset.section || row.querySelector('input')) return;
  const path = row.dataset.path;
  if (row.dataset.dir) {
    selectedDir = path;
    openDirs.has(path) ? openDirs.delete(path) : openDirs.add(path);
    store.set('openDirs', [...openDirs]);
    refreshTree(true);
  } else openNote(path);
});

function startRename(path) {
  const row = treeEl.querySelector(`.item[data-path="${CSS.escape(path)}"]`);
  if (!row) return;
  const label = row.querySelector('.label');
  const input = document.createElement('input');
  input.value = label.textContent;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async ok => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.remove();
    if (ok && name && name !== base(path)) {
      await flush();
      try {
        const np = await enqueue(() => invoke('rename', { path, name }));
        if (openDirs.delete(path)) { openDirs.add(np); store.set('openDirs', [...openDirs]); }
        remap(path, np);
      } catch (err) { toast(err); }
    }
    refreshTree(true);
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
}

async function trashItem(path) {
  await flush();
  try {
    await enqueue(() => invoke('delete', { path }));
    const open = current || sketchPath;
    if (open && (open === path || open.startsWith(path + '/'))) showEmpty();
    toast('Moved to Trash');
    refreshTree(true);
  } catch (err) { toast(err); }
}

// Linked folders: a folder elsewhere on disk, shown here through a symlink.
async function linkFolder(dir) {
  try {
    const p = await invoke('link_folder', { dir });
    if (!p) return;
    if (dir) openDirs.add(dir);
    openDirs.add(p);
    store.set('openDirs', [...openDirs]);
    refreshTree(true);
  } catch (err) { toast(err); }
}
async function unlinkFolder(path) {
  await flush();
  try {
    await enqueue(() => invoke('delete', { path }));
    const open = current || sketchPath;
    if (open && open.startsWith(path + '/')) showEmpty();
    toast('Folder unlinked. Its files are untouched');
    refreshTree(true);
  } catch (err) { toast(err); }
}

// Drag and drop to move pages and folders.
let dragPath = null;
treeEl.addEventListener('dragstart', e => {
  dragPath = e.target.closest('.item')?.dataset.path;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragPath);
});
// Dropping on a folder moves into it; on a page, into that page's folder; on empty space, to the top level.
function dropTarget(e) {
  const row = e.target.closest('.item');
  if (!row) return treeEl;
  if (row.dataset.dir) return row;
  const parent = dirOf(row.dataset.path);
  return parent ? treeEl.querySelector(`.item[data-path="${CSS.escape(parent)}"]`) || treeEl : treeEl;
}
treeEl.addEventListener('dragover', e => {
  if (!dragPath) return;
  const t = dropTarget(e);
  treeEl.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
  treeEl.classList.remove('drop-root');
  if (!t) return;
  e.preventDefault();
  t === treeEl ? treeEl.classList.add('drop-root') : t.classList.add('drop');
});
treeEl.addEventListener('dragleave', e => { if (!treeEl.contains(e.relatedTarget)) clearDrop(); });
function clearDrop() {
  treeEl.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
  treeEl.classList.remove('drop-root');
}
treeEl.addEventListener('drop', async e => {
  e.preventDefault();
  const t = dropTarget(e);
  clearDrop();
  const from = dragPath;
  dragPath = null;
  if (!t || !from) return;
  const dir = t === treeEl ? '' : t.dataset.path;
  if (dir === dirOf(from)) return;
  await flush();
  try {
    const np = await enqueue(() => invoke('move_item', { path: from, dir }));
    if (dir) openDirs.add(dir);
    remap(from, np);
    refreshTree(true);
  } catch (err) { toast(err); }
});
treeEl.addEventListener('dragend', () => { dragPath = null; clearDrop(); });

// ---------- context menu ----------
const ctx = $('#ctx');
function showMenu(x, y, items) {
  ctx.innerHTML = items.map((it, i) => it === '-' ? '<div class="popup-sep"></div>'
    : `<div class="popup-item${it.danger ? ' danger' : ''}" data-i="${i}">${it.label}</div>`).join('');
  ctx.hidden = false;
  ctx.style.left = Math.min(x, innerWidth - ctx.offsetWidth - 8) + 'px';
  ctx.style.top = Math.min(y, innerHeight - ctx.offsetHeight - 8) + 'px';
  ctx.onmousedown = e => {
    e.preventDefault();
    const el = e.target.closest('.popup-item');
    if (!el) return;
    ctx.hidden = true;
    items[+el.dataset.i].run();
  };
}
document.addEventListener('mousedown', e => {
  if (!ctx.contains(e.target)) ctx.hidden = true;
  if (!slashEl.contains(e.target) && slash) closeSlash();
});
const copyPath = p => navigator.clipboard.writeText(rootDir + (p ? '/' + p : '')).then(() => toast('Path copied'));
$('#sidebar').addEventListener('contextmenu', e => {
  e.preventDefault();
  const row = e.target.closest('.item');
  if (row?.dataset.path === SKETCHES) {
    return showMenu(e.clientX, e.clientY, [
      { label: 'New sketch', run: () => newSketch(SKETCHES) },
      { label: 'New folder', run: () => newFolder(SKETCHES) },
      '-',
      { label: 'Copy sketches folder path', run: () => copyPath(SKETCHES) },
    ]);
  }
  if (!row || row.dataset.section) {
    return showMenu(e.clientX, e.clientY, [
      { label: 'New page', run: () => newNote('') },
      { label: 'New sketch', run: () => newSketch(SKETCHES) },
      { label: 'New folder', run: () => newFolder('') },
      { label: 'Link folder from disk…', run: () => linkFolder('') },
      '-',
      { label: 'Copy notes folder path', run: () => copyPath('') },
    ]);
  }
  const path = row.dataset.path, sk = inSketches(path);
  const items = row.dataset.dir
    ? [{ label: sk ? 'New sketch inside' : 'New page inside', run: () => { openDirs.add(path); sk ? newSketch(path) : newNote(path); } },
       { label: 'New folder inside', run: () => newFolder(path) },
       ...(sk ? [] : [{ label: 'Link folder from disk…', run: () => linkFolder(path) }]), '-']
    : [{ label: 'Open', run: () => openNote(path) },
       { label: isSketch(path) ? 'Sketch history…' : 'Page history…', run: () => openHistory(path) },
       ...(isSketch(path) ? [] : [{ label: 'Export as PDF…', run: () => exportPdf(path) }]), '-'];
  items.push(
    { label: 'Rename', run: () => startRename(path) },
    { label: 'Copy path', run: () => copyPath(path) },
    '-',
    row.dataset.link
      ? { label: 'Unlink folder', run: () => unlinkFolder(path) }
      : { label: 'Move to Trash', danger: true, run: () => trashItem(path) },
  );
  showMenu(e.clientX, e.clientY, items);
});

// ---------- search palette ----------
const palette = $('#palette'), pInput = $('#palette-input'), pResults = $('#palette-results');
let hits = [], hitIndex = 0, searchTimer = null;
let historyPath = null; // set while the palette lists saved versions of a page
function openPalette() {
  historyPath = null;
  pInput.placeholder = 'Search pages…';
  palette.hidden = false;
  pInput.value = '';
  runSearch();
  pInput.focus();
}
function closePalette() { palette.hidden = true; pInput.blur(); }
async function runSearch() {
  hits = await invoke('search', { query: pInput.value.trim() });
  hitIndex = 0;
  renderHits();
}
function renderHits() {
  pResults.innerHTML = hits.length ? '' : '<div class="popup-empty">No results</div>';
  hits.forEach((h, i) => {
    const el = document.createElement('div');
    el.className = 'result' + (i === hitIndex ? ' sel' : '');
    el.innerHTML = '<div class="t"></div><div class="snip"></div>';
    el.querySelector('.t').textContent = h.title;
    el.querySelector('.snip').textContent = h.snippet;
    el.onmousedown = e => { e.preventDefault(); pick(i); };
    pResults.append(el);
  });
  pResults.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function pick(i) {
  closePalette();
  if (!hits[i]) return;
  if (historyPath) restoreVersion(historyPath, hits[i]);
  else openNote(hits[i].path);
}

// ---------- page history ----------
// The backend copies a page's previous text aside at most every 10 minutes while it is edited.
function ago(secs) {
  const d = new Date(secs * 1000), mins = Math.round((Date.now() - d) / 60000);
  const time = d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const rel = mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return `${time} · ${rel}`;
}
async function openHistory(path = current || sketchPath) {
  if (!path) return;
  await flush();
  let list;
  try { list = await invoke('history', { path }); } catch (err) { return toast(err); }
  if (!list.length) return toast('No older versions yet. One is saved every 10 minutes while you edit.');
  historyPath = path;
  hits = list.map(v => ({ id: v.id, title: ago(+v.id), snippet: `${v.words} words` }));
  hitIndex = 0;
  pInput.value = '';
  pInput.placeholder = `Restore an older version of “${base(path)}”`;
  palette.hidden = false;
  pInput.focus();
  renderHits();
}
async function restoreVersion(path, v) {
  let md;
  try { md = await invoke('read_version', { path, id: v.id }); } catch (err) { return toast(err); }
  if (isSketch(path)) {
    if (path !== sketchPath || !sketch) await openSketch(path);
    if (path !== sketchPath || !sketch) return;
    sketch.load(md);
    return toast('Restored. Press ⌘Z to undo.');
  }
  if (path !== current) await openNote(path);
  if (path !== current) return;
  render(md);
  snapshot();
  scheduleSave();
  focusBlock(editor.firstElementChild, 0);
  toast('Restored. Press ⌘Z to undo.');
}

pInput.addEventListener('input', () => {
  if (historyPath) return; clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 60); });
pInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); hitIndex = Math.min(hitIndex + 1, hits.length - 1); renderHits(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); hitIndex = Math.max(hitIndex - 1, 0); renderHits(); }
  else if (e.key === 'Enter') { e.preventDefault(); pick(hitIndex); }
  else if (e.key === 'Escape') closePalette();
});
palette.addEventListener('mousedown', e => { if (e.target === palette) closePalette(); });

// ---------- settings ----------
// Stored per machine in the app's local storage. Font names map to CSS stacks.
const FONTS = {
  'System': '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif',
  'New York': 'ui-serif, "New York", Georgia, serif',
  'SF Mono': 'ui-monospace, SFMono-Regular, Menlo, monospace',
  'Rounded': 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif',
  'Helvetica Neue': '"Helvetica Neue", Helvetica, sans-serif',
  'Avenir Next': '"Avenir Next", Avenir, sans-serif',
  'Inter': 'Inter, -apple-system, sans-serif',
  'Georgia': 'Georgia, serif',
  'Charter': 'Charter, Georgia, serif',
  'Iowan Old Style': '"Iowan Old Style", Georgia, serif',
  'Palatino': 'Palatino, "Palatino Linotype", serif',
  'Baskerville': 'Baskerville, Georgia, serif',
  'Menlo': 'Menlo, monospace',
  'Courier New': '"Courier New", Courier, monospace',
};
const DEFAULTS = { theme: 'light', uiFont: 'New York', pageFont: 'New York', codeFont: 'SF Mono', pageSize: '16' };
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const fontStack = name => FONTS[name] || `"${name.replace(/"/g, '')}", ${FONTS.System}`;

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  // Native window chrome (traffic lights, scrollbars) follows the same choice.
  window.__TAURI__.window.getCurrentWindow().setTheme(settings.theme === 'system' ? null : settings.theme).catch(() => {});
  root.style.setProperty('--ui-font', fontStack(settings.uiFont));
  root.style.setProperty('--page-font', fontStack(settings.pageFont));
  root.style.setProperty('--code-font', fontStack(settings.codeFont));
  root.style.setProperty('--page-size', settings.pageSize + 'px');
  for (const b of $('#theme-seg').children) b.classList.toggle('on', b.dataset.theme === settings.theme);
  sketch?.setTheme(themeNow());
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => sketch?.setTheme(themeNow()));
function setSetting(k, v) {
  settings[k] = v;
  store.set('settings', settings);
  applySettings();
}
$('#lang-list').innerHTML = hljs.listLanguages().map(l => `<option value="${l}">`).join('');
$('#font-list').innerHTML = Object.keys(FONTS).map(f => `<option value="${f}">`).join('');
const fontInputs = { uiFont: '#set-ui-font', pageFont: '#set-page-font', codeFont: '#set-code-font' };
for (const [k, sel] of Object.entries(fontInputs)) {
  const el = $(sel);
  el.addEventListener('input', () => { if (el.value.trim()) setSetting(k, el.value.trim()); });
  el.addEventListener('focus', () => { el.dataset.prev = el.value; el.value = ''; }); // show the full list
  el.addEventListener('blur', () => { if (!el.value.trim()) el.value = el.dataset.prev; });
}
$('#set-page-size').addEventListener('change', e => setSetting('pageSize', e.target.value));
$('#theme-seg').addEventListener('click', e => { if (e.target.dataset.theme) setSetting('theme', e.target.dataset.theme); });
function openSettings() {
  for (const [k, sel] of Object.entries(fontInputs)) $(sel).value = settings[k];
  $('#set-page-size').value = settings.pageSize;
  $('#settings').hidden = false;
}
const settingsEl = $('#settings');
settingsEl.addEventListener('mousedown', e => { if (e.target === settingsEl) settingsEl.hidden = true; });
settingsEl.addEventListener('keydown', e => { if (e.key === 'Escape') settingsEl.hidden = true; });
applySettings();

// ---------- global ----------
$('#settings-btn').onclick = openSettings;
$('#search-btn').onclick = openPalette;
$('#new-note-btn').onclick = () => newNote();
$('#new-folder-btn').onclick = () => newFolder();
$('#new-sketch-btn').onclick = () => newSketch();
$('#root-path').onclick = () => copyPath('');

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'y') {
    // Page undo whenever the page has focus or blocks are selected; native undo elsewhere (title, search).
    const a = document.activeElement;
    if (current && palette.hidden && settingsEl.hidden && (editor.contains(a) || a === document.body || !a)) {
      e.preventDefault();
      undo(k === 'y' || e.shiftKey ? 1 : -1);
    }
    return;
  }
  if (k === 'e' && e.shiftKey) { e.preventDefault(); exportPdf(); return; }
  if (k === 'k' || k === 'p') { e.preventDefault(); palette.hidden ? openPalette() : closePalette(); }
  else if (k === 'n' && e.shiftKey) { e.preventDefault(); newFolder(); }
  else if (e.code === 'KeyN' && e.altKey) { e.preventDefault(); newSketch(); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); togglePresent(); }
  else if (k === 'n') { e.preventDefault(); newNote(); }
  else if (k === 's') { e.preventDefault(); flush(); }
  else if (k === ',') { e.preventDefault(); settingsEl.hidden ? openSettings() : (settingsEl.hidden = true); }
  else if (k === '\\') { e.preventDefault(); document.body.classList.toggle('no-sidebar'); }
});

// Pick up edits made outside the app (AI agents, other editors, sync) every 2 seconds.
setInterval(() => {
  refreshTree().catch(() => {});
  enqueue(async () => {
    if (sketchPath && sketch && !sketchTimer) {
      const path = sketchPath;
      let json;
      try { json = await invoke('read_note', { path }); } catch { return showEmpty(); }
      if (path === sketchPath && json !== sketchSaved) { sketchSaved = json; sketch.load(json); }
      return;
    }
    if (!current || saveTimer || renameTimer) return;
    let md;
    try { md = await invoke('read_note', { path: current }); } catch { return showEmpty(); }
    if (md !== lastSaved) { lastSaved = md; render(md); snapshot(); }
  });
}, 2000);
window.addEventListener('blur', () => flush());

(async () => {
  rootDir = await invoke('root_dir');
  $('#root-path').textContent = rootDir.replace(/^\/Users\/[^/]+/, '~');
  await refreshTree(true);
  const last = store.get('last', null);
  if (last) await openNote(last).catch(() => {});
  else if (!treeEl.querySelector('.item')) {
    // First run: drop in a welcome page so the editor is not empty.
    const path = await invoke('create_note', { dir: '' });
    const np = await invoke('rename', { path, name: 'Welcome' }).catch(() => path);
    await invoke('write_note', { path: np, content: WELCOME });
    await refreshTree(true);
    await openNote(np);
  }
})();

const WELCOME = `Type **/** on an empty line to insert any block: headings, lists, to-dos, tables, code, quotes, callouts and dividers.

## Shortcuts

- **⌘N** new page, **⇧⌘N** new folder, **⌘K** search
- **⌘B** bold, **⌘I** italic, **⌘E** inline code, **⇧⌘X** strikethrough
- **Tab** / **⇧Tab** indent list items, **⇧⌘↑/↓** move a block
- Markdown works as you type: \`# \`, \`- \`, \`1. \`, \`[] \`, \`> \`, \`---\`, and three backticks for code

## Your notes are plain files

Every page is a Markdown file in your notes folder (path in the bottom-left corner). AI agents can read and edit them directly, and changes show up here within 2 seconds.

- [ ] Try the slash menu
- [ ] Make a table

| Feature | Status |
| --- | --- |
| Folders | Done |
| Search | Done |
`;
