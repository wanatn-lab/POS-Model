import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const orderHtml = await readFile(new URL("../public/order.html", import.meta.url), "utf8");

test("menu cards open an accessible detail sheet (focus trap, Escape, focus restore)", () => {
  assert.match(orderHtml, /id="menuDetailOverlay"/);
  assert.match(orderHtml, /role="dialog" aria-modal="true"/);
  for (const id of ["menuDetailImage", "menuDetailName", "menuDetailDescription", "menuDetailPrice", "menuDetailClose"]) {
    assert.match(orderHtml, new RegExp(`id="${id}"`));
  }
  assert.match(orderHtml, /class="card[^"]*" role="button" tabindex="0" data-detail-id="\$\{escAttr\(m\.id\)\}"/);
  assert.match(orderHtml, /function openMenuDetail\(id, opener\)/);
  assert.match(orderHtml, /menuDetailOpener = opener \|\| document\.activeElement/);
  assert.match(orderHtml, /menuDetailClose\.focus\(\)/);
  assert.match(orderHtml, /function closeMenuDetail\(\)/);
  assert.match(orderHtml, /e\.key === 'Escape' && S\.sheet/);
  assert.match(orderHtml, /menuDetailOverlay\.addEventListener\('keydown'/);
  assert.match(orderHtml, /event\.key !== 'Tab'/);
  assert.match(orderHtml, /menuDetailOpener\.focus\(\)/);
  // detail text is written with textContent, never as HTML
  assert.match(orderHtml, /\$\('#menuDetailName'\)\.textContent/);
  assert.match(orderHtml, /\$\('#menuDetailDescription'\)\.textContent/);
});

test("the page sends only what was chosen: no price or name in the order request", () => {
  const body = orderHtml.match(/const body = \{[\s\S]*?\};/)[0];
  assert.match(body, /menuId:l\.id/);
  assert.match(body, /optionIds:l\.opt/);
  assert.match(body, /idempotencyKey/);
  assert.doesNotMatch(body, /price|name/);
});

test("customer page keeps the existing features and hides prices by default", () => {
  for (const marker of ["/api/menu", "/api/settings", "/api/orders", "searchInput", "catNav", "data-act=\"go\" data-v=\"hist\"", "available === false", "mustTry", "popular", "t('nt0')"]) {
    assert.ok(orderHtml.includes(marker), `missing ${marker}`);
  }
  assert.match(orderHtml, /showPrices:false/);
  assert.match(orderHtml, /S\.showPrices \? /);
  assert.doesNotMatch(orderHtml, /admin-theme/);
});

test("theme colors from settings are accepted only as #rrggbb", () => {
  assert.match(orderHtml, /\/\^#\[0-9a-fA-F\]\{6\}\$\//);
});
