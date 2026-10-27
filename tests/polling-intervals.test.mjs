import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const root = new URL('../public/', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function loadCounterSettings(savedValue) {
  const html = read('counter-print.html');
  const start = html.indexOf('const STORAGE_KEY');
  const end = html.indexOf('\ninit();', start);
  assert.notEqual(start, -1, 'counter settings script exists');
  assert.notEqual(end, -1, 'counter settings script ends at init');
  const elements = new Map();
  const sandbox = {
    localStorage: {
      getItem: (key) => key === 'counterPrintSettings' ? savedValue : null,
      setItem() {},
    },
    document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
    window: {},
    console: { error() {} },
    clearInterval() {},
    setInterval() { return 1; },
    setTimeout() { return 1; },
  };
  vm.runInNewContext(`${html.slice(start, end)}\nglobalThis.counterSettings = settings;`, sandbox);
  return sandbox.counterSettings;
}

test('table-status pages refresh every 30 seconds', () => {
  assert.match(read('table-status.html'), /const REFRESH_MS = 30000;/);
  assert.match(read('admin.html'), /const REFRESH_MS = 30000;/);
});

test('counter print defaults to and enforces a 20-second minimum', () => {
  const html = read('counter-print.html');
  assert.match(html, /pollSec: 20,/);
  assert.match(html, /id="fPollSec" min="20" max="60" value="20"/);
  assert.deepEqual(JSON.parse(JSON.stringify(loadCounterSettings(JSON.stringify({ pollSec: 15 })))), {
    category: 'เครื่องดื่ม', shopName: 'ทองย้อย', pollSec: 20, autoPrint: true,
  });
});
