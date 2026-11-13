// Markdown <-> block model. Kept DOM-free so it can be tested with plain Node.
// A block is { type, text (inline markdown), indent, checked?, lang?, rows? }.
// Types: p h1 h2 h3 ul ol todo quote callout code table divider
(function (exports) {
  const LIST = new Set(['ul', 'ol', 'todo']);

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
  }

  function parse(md) {
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = Math.min(6, Math.floor(line.match(/^ */)[0].length / 2));
      const t = line.trim();
      let m;

      if ((m = t.match(/^```(.*)$/))) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
        blocks.push({ type: 'code', lang: m[1].trim(), text: code.join('\n') });
        continue;
      }
      if (t.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const rows = [splitRow(t)];
        i += 2;
        while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
        i--;
        const w = Math.max(...rows.map(r => r.length));
        rows.forEach(r => { while (r.length < w) r.push(''); });
        blocks.push({ type: 'table', rows });
        continue;
      }
      if (/^>\s*\[!\w+\]/.test(t)) {
        const body = [];
        while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) body.push(lines[++i].trim().replace(/^>\s?/, ''));
        blocks.push({ type: 'callout', text: body.join(' ') });
        continue;
      }
      if ((m = t.match(/^(#{1,6})\s+(.*)$/))) { blocks.push({ type: 'h' + Math.min(3, m[1].length), text: m[2] }); continue; }
      if ((m = t.match(/^[-*+]\s+\[([ xX])\]\s?(.*)$/))) { blocks.push({ type: 'todo', checked: m[1] !== ' ', text: m[2], indent }); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { blocks.push({ type: 'divider' }); continue; }
      if ((m = t.match(/^[-*+]\s+(.*)$/))) { blocks.push({ type: 'ul', text: m[1], indent }); continue; }
      if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { blocks.push({ type: 'ol', text: m[1], indent }); continue; }
      if ((m = t.match(/^>\s?(.*)$/))) { blocks.push({ type: 'quote', text: m[1] }); continue; }
      blocks.push({ type: 'p', text: t });
    }
    return blocks;
  }

  function serializeBlock(b, olNum) {
    const pad = '  '.repeat(b.indent || 0);
    switch (b.type) {
      case 'h1': return '# ' + b.text;
      case 'h2': return '## ' + b.text;
      case 'h3': return '### ' + b.text;
      case 'ul': return pad + '- ' + b.text;
      case 'ol': return pad + olNum + '. ' + b.text;
      case 'todo': return pad + '- [' + (b.checked ? 'x' : ' ') + '] ' + b.text;
      case 'quote': return '> ' + b.text;
      case 'callout': return '> [!NOTE]\n> ' + b.text;
      case 'divider': return '---';
      case 'code': return '```' + (b.lang || '') + '\n' + b.text + '\n```';
      case 'table': {
        const cell = c => ' ' + c.replace(/\|/g, '\\|').replace(/\n/g, ' ') + ' ';
        const row = r => '|' + r.map(cell).join('|') + '|';
        const [head, ...rest] = b.rows;
        return [row(head), '|' + head.map(() => ' --- ').join('|') + '|', ...rest.map(row)].join('\n');
      }
      default: return b.text;
    }
  }

  function serialize(blocks) {
    let out = '';
    const counters = [];
    blocks.forEach((b, i) => {
      // Empty paragraphs are spacing in the editor; Markdown has no way to store them.
      if (b.type === 'p' && !b.text.trim()) return;
      let num = 0;
      if (b.type === 'ol') {
        const lvl = b.indent || 0;
        counters.length = lvl + 1;
        num = counters[lvl] = (counters[lvl] || 0) + 1;
      } else if (!LIST.has(b.type)) counters.length = 0;
      const prev = blocks[i - 1];
      // Same-kind or nested list items stay tight; anything else gets a blank line.
      const tight = prev && LIST.has(prev.type) && LIST.has(b.type) && (prev.type === b.type || b.indent || prev.indent);
      if (out) out += tight ? '\n' : '\n\n';
      out += serializeBlock(b, num);
    });
    return out ? out + '\n' : '';
  }

  // Inline markdown -> HTML for display.
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inlineToHtml(md) {
    const codes = [];
    let s = esc(md).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => /^(https?:|mailto:)/i.test(u) ? `<a href="${u}">${t}</a>` : t)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<i>$2</i>')
      .replace(/(^|\W)_(?!\s)(.+?)_(?!\w)/g, '$1<i>$2</i>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => '<code>' + codes[n] + '</code>');
  }

  exports.MD = { parse, serialize, inlineToHtml, esc, LIST };
})(typeof module !== 'undefined' ? module.exports : window);
