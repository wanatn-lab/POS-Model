// Pure helpers for the ordered category list. Items store their category by name;
// the stored list only adds ORDER and lets a category exist while it has no items.
export const MAX_CATEGORIES = 40;
export const MAX_CATEGORY_LENGTH = 60;

const clean = (v) => String(v == null ? "" : v).trim();

// Trim, drop empties and duplicates, cap size. Returns null if input is not an array.
export function normalizeCategories(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const raw of list) {
    const name = clean(raw).slice(0, MAX_CATEGORY_LENGTH);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

// Stored order first, then any category used by an item but missing from the list
// (first-appearance order), so no item can ever become invisible to customers.
export function orderedCategories(menu, stored) {
  const out = normalizeCategories(stored) || [];
  for (const item of Array.isArray(menu) ? menu : []) {
    const name = clean(item && item.category);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// Stable sort of items by category order; uncategorised items go last.
export function sortMenuByCategories(menu, order) {
  const rank = new Map(order.map((name, i) => [name, i]));
  const at = (item) => {
    const r = rank.get(clean(item && item.category));
    return r === undefined ? order.length : r;
  };
  return menu.map((item, i) => ({ item, i }))
    .sort((a, b) => at(a.item) - at(b.item) || a.i - b.i)
    .map((x) => x.item);
}
