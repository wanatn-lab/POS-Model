import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const orderHtml = await readFile(new URL("../public/order.html", import.meta.url), "utf8");
const styleCss = await readFile(new URL("../public/style.css", import.meta.url), "utf8");

test("menu cards expose an accessible detail sheet without putting item text in HTML", () => {
  assert.match(orderHtml, /id="menuDetailOverlay" class="sheet-overlay"/);
  assert.match(orderHtml, /id="menuDetailImage"/);
  assert.match(orderHtml, /id="menuDetailName"/);
  assert.match(orderHtml, /id="menuDetailDescription"/);
  assert.match(orderHtml, /id="menuDetailPrice"/);
  assert.match(orderHtml, /class="body"[^>]*role="button"[^>]*tabindex="0"/);
  assert.match(orderHtml, /data-detail-id="\$\{escAttr\(item\.id\)\}"/);
  assert.match(orderHtml, /onclick="openMenuDetail\(this\.dataset\.detailId, this\)"/);
  assert.match(orderHtml, /onkeydown="if \(event\.key === 'Enter' \|\| event\.key === ' '\) \{ event\.preventDefault\(\); openMenuDetail\(this\.dataset\.detailId, this\) \}/);
  assert.match(orderHtml, /function openMenuDetail\(id, opener\)/);
  assert.match(orderHtml, /menuDetailName\.textContent = item\.name/);
  assert.match(orderHtml, /menuDetailDescription\.textContent = item\.desc \|\| ''/);
  assert.match(orderHtml, /menuDetailImage\.src = item\.image/);
  assert.match(orderHtml, /function closeMenuDetail\(\)/);
  assert.match(orderHtml, /event\.key === 'Escape'/);
  assert.match(orderHtml, /event\.preventDefault\(\);\s*openMenuDetail\(this\.dataset\.detailId, this\)/);
  assert.match(orderHtml, /menuDetailOpener\s*=\s*opener \|\| document\.activeElement/);
  assert.match(orderHtml, /menuDetailClose\.focus\(\)/);
  assert.match(orderHtml, /menuDetailOverlay\.addEventListener\('keydown'/);
  assert.match(orderHtml, /event\.key !== 'Tab'/);
  assert.match(orderHtml, /event\.preventDefault\(\)/);
  assert.match(orderHtml, /menuDetailOpener\.focus\(\)/);
  assert.match(styleCss, /\.menu-detail-panel/);
  assert.match(styleCss, /\.menu-detail-image/);
});
