import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../public/", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const admin = read("admin.html");

const requiredIds = [
  "shopStatusBox", "shopStatusText", "shopToggleBtn", "shopClearBtn", "hoursRows", "hoursSaveBtn", "menuCategoryFilter",
  "cloudinaryCloudName", "cloudinaryUploadPreset", "itemList", "tableCount", "qrGrid",
  "paperWidthMm", "shopName", "agentBanner", "printerList", "printerForm",
  "ts-grid", "ts-overlay", "ts-panel", "ts-orderList", "ts-clearTableBtn", "ts-checkoutBtn",
  "ts-menuModalWrap", "ts-checkoutWrap", "ts-receiptPrint", "bh-list", "bh-modal",
  "rcReceiptPaper", "rcKitchenPaper", "rcPreviewLogo", "rcSaveNote",
];

const inlineFunctions = [
  "saveCloudinarySettings", "addBlankItem", "saveMenu", "removeItem", "uploadMenuImage",
  "clearMenuImage", "setMenuMustTry", "setMenuAvailability", "genQr", "downloadAllQr",
  "downloadOneQr", "sendQrToCounter", "openPrinterForm", "closePrinterForm",
  "savePrinterForm", "removePrinter", "saveGeneralPrintSettings", "rcSwitchTab",
  "rcSetKitchenSize", "rcRender", "rcSaveSettings", "uploadReceiptLogo", "clearReceiptLogo",
];

test("admin redesign preserves the static UI contract", () => {
  assert.match(admin, /<body class="admin-redesign">/);
  assert.match(admin, /<link rel="stylesheet" href="\/admin-theme\.css\?v=1">/);
  for (const id of requiredIds) assert.match(admin, new RegExp(`id="${id}"`), `missing #${id}`);
  for (const name of inlineFunctions) {
    assert.match(admin, new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`), `missing global ${name}`);
  }
});

test("checkout confirmation uses printer-neutral receipt wording", () => {
  const checkout = admin.slice(admin.indexOf("async function finishCheckout"), admin.indexOf('document.getElementById("ts-printReceiptBtn").onclick'));
  assert.match(checkout, /ส่งใบเสร็จไปเครื่องพิมพ์แล้ว/);
  assert.doesNotMatch(checkout, /iMin/);
});

test("admin keeps all tabs, deep links and the protected script order", () => {
  const tabs = [...admin.matchAll(/class="tab-btn(?: active)?" data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["tablestatus", "menu", "qr", "printers", "receipt", "billhistory", "hours"]);
  for (const tab of tabs) assert.match(admin, new RegExp(`id="panel-${tab}" class="panel`), `missing panel for ${tab}`);
  assert.match(admin, /return ADMIN_TABS\.has\(tab\) \? tab : 'tablestatus';/);
  assert.match(admin, /const selected = ADMIN_TABS\.has\(tab\) \? tab : 'tablestatus';/);
  const scripts = ["/auth-gate.js", "/shop-hours.js", "qrcode.min.js", "browser-image-compression", "jszip.min.js"];
  let previous = -1;
  for (const script of scripts) {
    const index = admin.indexOf(script);
    assert.ok(index > previous, `${script} is missing or out of order`);
    previous = index;
  }
});

test("shop name comes from settings; technical identifiers are unchanged", () => {
  assert.match(admin, /<title>แอดมิน<\/title>/);
  assert.match(admin, /<span id="brandName">ร้านของฉัน<\/span> <small>· แอดมิน<\/small>/);
  assert.match(admin, /function applyShopBranding\(name\)/);
  assert.match(admin, /applyShopBranding\(SETTINGS\.shopName\);/);
  assert.match(admin, /placeholder="เช่น thongyoi_menu_unsigned"/);
  assert.match(admin, /const CLOUDINARY_MENU_FOLDER = 'thongyoi_menu';/);
  assert.match(admin, /id="cloudinaryFolderLabel"/);
  assert.match(admin, /function cloudinaryFolder\(savedFolder\)/);
  assert.match(admin, /folder === 'menujk_up' \? CLOUDINARY_MENU_FOLDER : folder/);
  assert.match(admin, /folder: cloudinaryFolder\(config\.folder\)/);
  assert.match(admin, /cloudinary: \{ cloudName, uploadPreset, folder \}/);
  assert.match(admin, /form\.append\('folder', config\.folder\)/);
  assert.match(admin, /X-Jinko-Client/);
  // No page may hardcode the old shop's name; names come from settings.shopName.
  for (const page of ["admin.html", "order.html", "table-status.html", "counter-print.html", "kitchen.html", "kitchen-manifest.webmanifest", "kitchen-assets/main.js"]) {
    assert.doesNotMatch(read(page), /ทองย้อย/, `${page} must not hardcode the shop name`);
  }
  assert.match(read("order.html"), /<h1 id="shopTitle" class="n1">ร้านของฉัน<\/h1>/);
  assert.match(read("table-status.html"), /id="brandName"/);
  assert.match(read("kitchen-assets/main.js"), /s\.shopName|\.shopName/);
  for (const file of ["../api/table-status.js", "../api/settings.js"]) {
    assert.doesNotMatch(readFileSync(new URL(file, new URL("../public/", import.meta.url)), "utf8"), /ทองย้อย|ข้าวหมูแดง/, `${file} must not hardcode a shop name`);
  }
});

test("Cloudinary replaces the old restaurant folder but retains a custom folder", () => {
  const start = admin.indexOf("function cloudinaryFolder(savedFolder)");
  const end = admin.indexOf("function cloudinaryReady()");
  assert.ok(start > 0 && end > start, "Cloudinary config helper not found");
  const sandbox = { SETTINGS: {} };
  vm.createContext(sandbox);
  vm.runInContext("const CLOUDINARY_MENU_FOLDER = 'thongyoi_menu';\n" + admin.slice(start, end) + "\nthis.cloudinaryConfig = cloudinaryConfig;", sandbox);
  assert.equal(sandbox.cloudinaryConfig().folder, "thongyoi_menu");
  sandbox.SETTINGS = { cloudinary: { folder: "menujk_up" } };
  assert.equal(sandbox.cloudinaryConfig().folder, "thongyoi_menu");
  sandbox.SETTINGS = { cloudinary: { folder: "existing_menu_folder" } };
  assert.equal(sandbox.cloudinaryConfig().folder, "existing_menu_folder");
});

test("menu image errors use the no-image state", () => {
  assert.match(admin, /onerror="this\.style\.display='none'; document\.getElementById\('imgEmpty\$\{i\}'\)\.style\.display='flex'; document\.getElementById\('imgEmpty\$\{i\}'\)\.textContent='🖼️ ยังไม่มีรูป'"/);
  assert.doesNotMatch(admin, /โหลดไม่ได้/);
});

test("table-status dashboard keeps hooks and renders SVG cards with real data", () => {
  for (const id of ["ts-grid", "ts-filters", "ts-sumEmpty", "ts-sumPending", "ts-sumAmount", "ts-panel", "ts-overlay"]) {
    assert.match(admin, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  const grid = admin.slice(admin.indexOf("function tableSvg("), admin.indexOf("/* ---------------- Summary"));
  assert.match(grid, /class="tsv"/);
  for (const part of ['class="ch"', 'class="tp"', 'class="ti"', 'class="tx"']) assert.ok(grid.includes(part), `svg missing ${part}`);
  assert.equal((grid.match(/class="ch"/g) || []).length, 4, "four chairs expected");
  assert.match(grid, /card\.onclick = \(\)=>openPanel\(t\.id\);/);
  assert.match(grid, /document\.createElement\("button"\)/);
  assert.match(grid, /card\.type = "button"/);
  assert.match(grid, /t\.items\.slice\(0,2\)/);
  assert.match(grid, /\+\$\{lines-2\}/);
  assert.match(grid, /tableTotal\(t\)/);
  assert.match(grid, /escapeHtml\(preview\)/);
  assert.match(grid, /const text = escapeHtml\(title\)/);
  assert.match(admin, /function renderAll\(\)\{\s*renderFilters\(\);\s*renderGrid\(\);\s*renderSummary\(\);/);
  assert.match(admin, /getElementById\("ts-sumAmount"\)\.textContent = "฿" \+ fmtBaht\(TABLES\.reduce/);
  assert.match(admin, /function escapeHtml\(value\)/);
});

test("table-status theme CSS is scoped to the admin redesign", () => {
  const css = read("admin-theme.css");
  const start = css.indexOf("body.admin-redesign #panel-tablestatus .ts-summary-row");
  const block = css.slice(start, css.indexOf("#panel-tablestatus .panel-head"));
  for (const line of block.split("\n").filter((l) => l.includes("{"))) {
    assert.match(line.trim(), /^body\.admin-redesign #panel-tablestatus/, `unscoped rule: ${line.slice(0, 60)}`);
  }
  assert.match(css, /#panel-tablestatus \.grid \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("table-status page chrome CSS stays scoped to #panel-tablestatus", () => {
  const css = read("admin-theme.css");
  const chrome = css.slice(css.indexOf("*/", css.indexOf("Table-status page chrome")) + 2, css.indexOf("/* ===== Menu management tab"));
  assert.ok(chrome.length > 300, "chrome block missing");
  for (const line of chrome.split("\n")) {
    if (!line.trim() || /^\s/.test(line) || /^[}/@]/.test(line)) continue;
    assert.match(line, /^body\.admin-redesign #panel-tablestatus/, `unscoped line: ${line.slice(0, 70)}`);
  }
  assert.doesNotMatch(css, /Prototype v2 fidelity layer/);
});

test("menu tab keeps every control, handler and API call", () => {
  for (const id of ["itemList", "menuCategoryFilter", "cloudinaryCloudName", "cloudinaryUploadPreset", "cloudinaryConfigBadge", "cloudinaryConfigNote"]) {
    assert.match(admin, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  for (const template of ['id="imgFile${i}"', 'id="imgPicker${i}"', 'id="imgPreview${i}"', 'id="imgEmpty${i}"', 'id="imgUploadStatus${i}"']) {
    assert.ok(admin.includes(template), `menu card template lost ${template}`);
  }
  for (const handler of [
    "oninput=\"MENU[${i}].name = this.value\"", "oninput=\"MENU[${i}].price = Number(this.value)\"",
    "oninput=\"MENU[${i}].category = this.value\"", "oninput=\"MENU[${i}].desc = this.value; refreshEnStatus(${i})\"",
    "onchange=\"uploadMenuImage(${i}, this)\"", "onclick=\"clearMenuImage(${i})\"",
    "onchange=\"setMenuMustTry(${i}, this.checked, this)\"", "onchange=\"setMenuAvailability(${i}, this.checked, this)\"",
    "onclick=\"removeItem(${i})\"", 'onclick="addBlankItem()"', 'onclick="saveMenu()"', 'onclick="saveCloudinarySettings()"',
  ]) assert.ok(admin.includes(handler), `missing handler ${handler}`);
  assert.match(admin, /fetch\(API \+ '\/api\/menu', \{\s*method: 'POST',/);
  assert.match(admin, /body: JSON\.stringify\(\{ menu: menuForSave, categories: menuCategories\(\) \}\)/);
  assert.match(admin, /alt="\$\{escAttr\(item\.name\) \|\| 'รูปเมนู'\}"/);
});

test("menu redesign adds no mock data and stays out of customer pages", () => {
  assert.match(admin, /el\.innerHTML = visibleItems\.map\(/);
  assert.match(admin, /let MENU = \[\];/);
  const menuPanel = admin.slice(admin.indexOf('<section id="panel-menu"'), admin.indexOf('<section id="panel-qr"'));
  const menuRender = admin.slice(admin.indexOf("function renderList()"), admin.indexOf("function addBlankItem()"));
  assert.ok(menuPanel.length > 200 && menuRender.length > 200, "menu code slices missing");
  assert.doesNotMatch(menuPanel + menuRender, /ไส้อั่ว|ข้าวนึ่ง|แกงฮังเล|น้ำพริกหนุ่ม|ลาบหมู|ชาเย็น/);
  const css = read("admin-theme.css");
  const block = css.slice(css.indexOf("*/", css.indexOf("Menu management tab")) + 2);
  assert.ok(block.length > 1000, "menu block missing");
  for (const line of block.split("\n")) {
    if (!line.trim() || /^\s/.test(line) || /^[}/@]/.test(line)) continue;
    assert.match(line, /^body\.admin-redesign #panel-menu/, `unscoped menu rule: ${line.slice(0, 70)}`);
  }
  assert.doesNotMatch(read("style.css"), /admin-redesign|#panel-menu/);
  assert.doesNotMatch(read("order.html"), /admin-theme/);
});

test("admin shell CSS (header + floating tabs) is scoped and keeps tab hooks", () => {
  const css = read("admin-theme.css");
  const start = css.indexOf("*/", css.indexOf("Admin shell: header")) + 2;
  const shell = css.slice(start, css.indexOf("/* ===== Table-status page chrome"));
  assert.ok(shell.length > 1000, "shell block missing");
  for (const line of shell.split("\n")) {
    if (!line.trim() || /^\s/.test(line) || /^[}/@]/.test(line)) continue;
    assert.match(line, /^body\.admin-redesign[ .\[:]/, `unscoped shell rule: ${line.slice(0, 70)}`);
  }
  assert.match(shell, /\.topbar \{ position:relative;/);
  assert.match(shell, /\.tabs \{ position:relative; z-index:20;/);
  assert.doesNotMatch(shell, /\.tab-btn[^{]*\{[^}]*display\s*:\s*none/);
});

test("table-status side panel reuses the real drawer and menu edit button reuses the inline form", () => {
  const html = read("admin.html");
  const css = read("admin-theme.css");
  // side panel: same drawer element, ids and handlers; only an empty-state hint is added
  for (const id of ["ts-panel", "ts-panelTitle", "ts-orderList", "ts-closePanel", "ts-clearTableBtn", "ts-addItemBtn", "ts-checkoutBtn", "ts-overlay", "ts-selectHint"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /function openPanel\(id\)\{\s*activeTableId = id;\s*renderPanel\(\);/);
  assert.match(html, /card\.onclick = \(\)\s*=>\s*openPanel\(t\.id\)/);
  const side = css.slice(css.indexOf("*/", css.indexOf("Table-status detail panel")) + 2, css.indexOf("/* ===== Menu management tab"));
  assert.ok(side.length > 800);
  for (const line of side.split("\n")) {
    const l = line.trim();
    if (!l || l === "}" || l.startsWith("@media")) continue;
    assert.match(l, /^body\.admin-redesign #panel-tablestatus/, `unscoped side-panel rule: ${l.slice(0, 70)}`);
  }
  assert.match(side, /min-width:1000px/);
  // menu: edit button toggles a view-only class; form inputs and handlers stay in the same card
  assert.match(html, /class="menu-edit-toggle"[^>]*onclick="toggleMenuEdit\(\$\{i\}, this\)"/);
  assert.match(html, /function toggleMenuEdit\(i, btn\)/);
  assert.match(html, /adminMenuEditing\.add\(MENU\[MENU\.length - 1\]\)/);
  for (const h of ["MENU[${i}].name = this.value", "MENU[${i}].price = Number(this.value)", "removeItem(${i})", "uploadMenuImage(${i}, this)"]) {
    assert.ok(html.includes(h), `handler lost: ${h}`);
  }
  assert.ok(!/toggleMenuEdit[^}]*fetch\(/.test(html.slice(html.indexOf("function toggleMenuEdit"), html.indexOf("function toggleMenuEdit") + 500)), "edit toggle must not call the API");
});

test("menu card layout does not depend on child position, so extra EN fields cannot break it", () => {
  const css = read("admin-theme.css");
  const cardRules = css.split("\n").filter((line) => line.includes("#itemList .item-form"));
  assert.ok(cardRules.length > 10, "menu card rules not found");
  assert.equal(cardRules.filter((line) => /\.row:nth-child\(/.test(line)).length, 0, "use .row:nth-of-type, not .row:nth-child");
  assert.match(css, /\.item-form > label:not\(\.en-label\) \{/);
  assert.match(css, /\.item-form > input:not\(\.en-input\) \{/);
  for (const cls of ["en-label-name", "en-input-name", "en-label-desc", "en-input-desc", "en-chip"]) {
    assert.match(css, new RegExp("\\.item-form > \\." + cls + " \\{"), "missing placement rule for ." + cls);
  }
  assert.match(css, /\.item-form:not\(\.is-editing\) > \.en-chip \{ display:none; \}/);
  for (const marker of ['class="en-label en-label-name"', 'class="en-input en-input-name"', 'class="en-label en-label-desc"', 'class="en-input en-input-desc"']) {
    assert.ok(admin.includes(marker), "menu card template lost " + marker);
  }
});
