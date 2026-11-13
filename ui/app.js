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

function changed() { scheduleSave(); }

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

editor.addEventListener('paste', e => {
  const block = e.target.closest('.block');
  if (!block) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  if (!text) return;
  const plain = block.dataset.type === 'code' || e.target.classList.contains('lang');
  if (plain || !text.includes('\n') || e.target.closest('.cell')) {
    document.execCommand('insertText', false, plain ? text : text.replace(/\s*\n\s*/g, ' '));
    return;
  }
  // Multi-line paste: treat it as Markdown and turn it into blocks.
  const els = MD.parse(text).map(makeBlock);
  if (!els.length) return;
  if (TEXT.has(block.dataset.type) && !content(block).textContent.trim()) block.replaceWith(...els);
  else block.after(...els);
  focusBlock(els[els.length - 1], 'end');
  renumber();
  changed();
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
  if (renameTimer) await renameCurrent();
  await save();
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
  current = null;
  lastSaved = null;
  $('#page').hidden = true;
  store.set('last', null);
  markActive();
}

async function openNote(path, { focusTitle = false } = {}) {
  await flush();
  closeSlash();
  let md;
  try { md = await invoke('read_note', { path }); } catch (err) { toast(err); return; }
  current = path;
  lastSaved = md;
  selectedDir = dirOf(path);
  store.set('last', path);
  titleEl.textContent = base(path);
  showCrumbs();
  render(md);
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
  await flush();
  try {
    const path = await invoke('create_note', { dir });
    await refreshTree(true);
    await openNote(path, { focusTitle: true });
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
  if (!current) return;
  if (current === from) current = to;
  else if (current.startsWith(from + '/')) current = to + current.slice(from.length);
  else return;
  store.set('last', current);
  titleEl.textContent = base(current);
  showCrumbs();
}

// ---------- tree ----------
const ICON_PAGE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/></svg>';
const ICON_FOLDER = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z"/></svg>';

async function refreshTree(force) {
  if (treeEl.querySelector('input')) return; // don't clobber an inline rename
  const nodes = await invoke('tree');
  const json = JSON.stringify(nodes);
  if (!force && json === treeJson) return;
  treeJson = json;
  treeEl.replaceChildren();
  if (!nodes.length) treeEl.innerHTML = '<div class="empty-tree">No pages yet</div>';
  renderNodes(nodes, treeEl, 0);
  markActive();
}
function renderNodes(nodes, parent, depth) {
  for (const n of nodes) {
    const row = document.createElement('div');
    row.className = 'item';
    row.dataset.path = n.path;
    row.dataset.dir = n.dir ? '1' : '';
    row.draggable = true;
    row.style.paddingLeft = depth * 14 + 4 + 'px';
    const isOpen = openDirs.has(n.path);
    row.innerHTML = `<span class="twisty">${n.dir ? (isOpen ? '▼' : '▶') : ''}</span><span class="icon">${n.dir ? ICON_FOLDER : ICON_PAGE}</span><span class="label"></span>`;
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
  for (const el of treeEl.querySelectorAll('.item')) el.classList.toggle('active', el.dataset.path === current);
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
  if (!row || row.querySelector('input')) return;
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
    if (current && (current === path || current.startsWith(path + '/'))) showEmpty();
    toast('Moved to Trash');
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
function dropTarget(e) {
  const row = e.target.closest('.item');
  if (row) return row.dataset.dir ? row : null;
  return treeEl;
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
  if (!row) {
    return showMenu(e.clientX, e.clientY, [
      { label: 'New page', run: () => newNote('') },
      { label: 'New folder', run: () => newFolder('') },
      '-',
      { label: 'Copy notes folder path', run: () => copyPath('') },
    ]);
  }
  const path = row.dataset.path;
  const items = row.dataset.dir
    ? [{ label: 'New page inside', run: () => { openDirs.add(path); newNote(path); } },
       { label: 'New folder inside', run: () => newFolder(path) }, '-']
    : [{ label: 'Open', run: () => openNote(path) }, '-'];
  items.push(
    { label: 'Rename', run: () => startRename(path) },
    { label: 'Copy path', run: () => copyPath(path) },
    '-',
    { label: 'Move to Trash', danger: true, run: () => trashItem(path) },
  );
  showMenu(e.clientX, e.clientY, items);
});

// ---------- search palette ----------
const palette = $('#palette'), pInput = $('#palette-input'), pResults = $('#palette-results');
let hits = [], hitIndex = 0, searchTimer = null;
function openPalette() {
  palette.hidden = false;
  pInput.value = '';
  runSearch();
  pInput.focus();
}
function closePalette() { palette.hidden = true; }
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
  if (hits[i]) openNote(hits[i].path);
}
pInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 60); });
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
const DEFAULTS = { theme: 'system', uiFont: 'System', pageFont: 'System', codeFont: 'SF Mono', pageSize: '16' };
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
}
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
$('#root-path').onclick = () => copyPath('');

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'k' || k === 'p') { e.preventDefault(); palette.hidden ? openPalette() : closePalette(); }
  else if (k === 'n' && e.shiftKey) { e.preventDefault(); newFolder(); }
  else if (k === 'n') { e.preventDefault(); newNote(); }
  else if (k === 's') { e.preventDefault(); flush(); }
  else if (k === ',') { e.preventDefault(); settingsEl.hidden ? openSettings() : (settingsEl.hidden = true); }
  else if (k === '\\') { e.preventDefault(); document.body.classList.toggle('no-sidebar'); }
});

// Pick up edits made outside the app (AI agents, other editors, sync) every 2 seconds.
setInterval(() => {
  refreshTree().catch(() => {});
  enqueue(async () => {
    if (!current || saveTimer || renameTimer) return;
    let md;
    try { md = await invoke('read_note', { path: current }); } catch { return showEmpty(); }
    if (md !== lastSaved) { lastSaved = md; render(md); }
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
