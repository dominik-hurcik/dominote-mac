// Round-trip check for the Markdown parser/serializer. Run: node tests/md.test.js
const assert = require('assert');
const { MD } = require('../ui/md.js');

const doc = `# Title

Some **bold** and *italic* and \`code\` and [link](https://x.com).

- one
  - nested
- two

1. first
2. second

- [ ] todo
- [x] done

> a quote

> [!NOTE]
> callout text

---

\`\`\`rust
fn main() {
    println!("hi");
}
\`\`\`

| A | B \\| pipe |
| --- | --- |
| 1 | 2 |
`;

const blocks = MD.parse(doc);
assert.deepStrictEqual(blocks.map(b => b.type),
  ['h1', 'p', 'ul', 'ul', 'ul', 'ol', 'ol', 'todo', 'todo', 'quote', 'callout', 'divider', 'code', 'table']);
assert.strictEqual(blocks[3].indent, 1);
assert.strictEqual(blocks[8].checked, true);
assert.strictEqual(blocks[12].lang, 'rust');
assert.deepStrictEqual(blocks[13].rows, [['A', 'B | pipe'], ['1', '2']]);
assert.strictEqual(MD.serialize(blocks), doc, 'round trip must be lossless');

const html = MD.inlineToHtml('a **b** *c* `<x>` ~~d~~ [e](javascript:void)');
assert.strictEqual(html, 'a <b>b</b> <i>c</i> <code>&lt;x&gt;</code> <s>d</s> e');
console.log('md ok');
