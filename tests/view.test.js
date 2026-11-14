// View preferences never change note content and follow renamed notes and folders.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map();
const $ = id => {
  if (!elements.has(id)) elements.set(id, {
    style: { setProperty(k, v) { this[k] = v; } },
    classList: { toggle(k, v) { this[k] = v; } },
    addEventListener() {},
  });
  return elements.get(id);
};
const context = vm.createContext({ $, document: { addEventListener() {} }, store: { get: () => ({}), set() {} } });
const source = fs.readFileSync('ui/app.js', 'utf8');
vm.runInContext('let current = "folder/a.md";\n' + source.slice(source.indexOf('// View preferences'), source.indexOf('// ---------- helpers')), context);
vm.runInContext(`
  applyPageView();
  if ($('#view-zoom').value !== 100 || $('#view-wide').checked) throw Error('Bad defaults');
  pageViews[current] = { zoom: 80, wide: true };
  applyPageView();
`, context);
assert.equal($('#page').style['--view-zoom'], 0.8);
assert.equal($('#page').classList['full-width'], true);
vm.runInContext(`
  remapPageViews('folder', 'moved');
  current = 'moved/a.md';
  applyPageView();
  if (pageViews['folder/a.md']) throw Error('Old path retained');
`, context);
assert.equal($('#view-zoom').value, 80);
vm.runInContext(`current = 'other.md'; applyPageView();`, context);
assert.equal($('#view-zoom').value, 100);
assert.equal($('#view-wide').checked, false);
vm.runInContext(`pageViews[current] = { zoom: 12 }; applyPageView();`, context);
assert.equal($('#view-zoom').value, 100);
vm.runInContext(`current = null; applyPageView();`, context);
assert.equal($('#page-view').hidden, true);
console.log('view ok');
