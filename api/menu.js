import { redis } from "./_redis.js";
import { normalizeCategories, orderedCategories, sortMenuByCategories } from "./_menu-categories.js";

// A new shop starts with no fabricated products or prices. The owner imports or
// enters the real menu in Admin before accepting customer orders.
const SEED_MENU = [];
const CATEGORIES_KEY = "menuCategories";

// Option choices become part of an order's server-calculated price, so reject
// incomplete or ambiguous menu data before it can be saved.
export function optionGroupsError(menu) {
  for (const item of menu) {
    if (item.optionGroups === undefined) continue;
    if (!Array.isArray(item.optionGroups)) return "optionGroups must be a list";
    const groupIds = new Set();
    const optionIds = new Set();
    for (const group of item.optionGroups) {
      if (!group || typeof group !== "object") return "invalid option group";
      const groupId = String(group.id || "");
      if (!groupId || groupIds.has(groupId)) return "option group id missing or duplicated";
      groupIds.add(groupId);
      if (!String(group.name || "").trim()) return "option group needs a name";
      if (group.type !== "single" && group.type !== "multi") return "option group type must be single or multi";
      if (typeof group.required !== "boolean") return "option group required must be boolean";
      if (!Array.isArray(group.options) || !group.options.length) return "option group needs at least one option";
      for (const option of group.options) {
        if (!option || typeof option !== "object") return "invalid option";
        const optionId = String(option.id || "");
        if (!optionId || optionIds.has(optionId)) return "option id missing or duplicated";
        optionIds.add(optionId);
        if (!String(option.name || "").trim()) return "option needs a name";
        const delta = Number(option.priceDelta);
        if (!Number.isInteger(delta) || delta < 0 || delta > 100000) return "option priceDelta must be a whole number of baht, 0 or more";
      }
    }
  }
  return "";
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    let menu = await redis.get("menu");
    if (!menu) {
      menu = SEED_MENU;
      await redis.set("menu", menu);
    }
    const stored = await redis.get(CATEGORIES_KEY);
    const categories = orderedCategories(menu, stored);
    // Items are returned grouped in category order, so the customer page follows
    // the owner's order without any change. Without a stored list nothing moves.
    const sorted = Array.isArray(stored) ? sortMenuByCategories(menu, categories) : menu;
    if (req.query && req.query.include === "categories") {
      return res.status(200).json({ menu: sorted, categories });
    }
    return res.status(200).json(sorted);
  }

  if (req.method === "POST") {
    const body = req.body;

    // Updating "sold out" must never overwrite unrelated menu details from
    // an out-of-date admin page. Update only this one field in Redis instead
    // of saving the complete client-side menu array.
    if (body && !Array.isArray(body) && body.action === "set-availability") {
      const id = String(body.id || "").trim();
      if (!id || typeof body.available !== "boolean") {
        return res.status(400).json({ ok: false, error: "missing id or available" });
      }

      const menu = (await redis.get("menu")) || SEED_MENU;
      const index = menu.findIndex((item) => String(item.id) === id);
      if (index < 0) {
        return res.status(404).json({ ok: false, error: "menu item not found" });
      }

      menu[index] = { ...menu[index], available: body.available };
      await redis.set("menu", menu);
      return res.status(200).json({ ok: true, item: menu[index] });
    }

    // Admin save: { menu: [...], categories: [...] } (legacy: a bare array).
    let menu = body;
    let categories = null;
    if (body && !Array.isArray(body) && Array.isArray(body.menu)) {
      menu = body.menu;
      categories = normalizeCategories(body.categories);
      if (body.categories !== undefined && categories === null) {
        return res.status(400).json({ ok: false, error: "categories must be an array" });
      }
    }
    if (!Array.isArray(menu)) {
      return res.status(400).json({ ok: false, error: "expected an array of menu items" });
    }
    const optionProblem = optionGroupsError(menu);
    if (optionProblem) return res.status(400).json({ ok: false, error: optionProblem });
    if (categories !== null) {
      categories = orderedCategories(menu, categories);
      menu = sortMenuByCategories(menu, categories);
      await redis.set(CATEGORIES_KEY, categories);
    }
    await redis.set("menu", menu);
    return res.status(200).json({ ok: true, categories: categories || undefined });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
}
