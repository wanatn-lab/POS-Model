import { redis } from "./_redis.js";

// A new shop starts with no fabricated products or prices. The owner imports or
// enters the real menu in Admin before accepting customer orders.
const SEED_MENU = [];

export default async function handler(req, res) {
  if (req.method === "GET") {
    let menu = await redis.get("menu");
    if (!menu) {
      menu = SEED_MENU;
      await redis.set("menu", menu);
    }
    return res.status(200).json(menu);
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

    const menu = body;
    if (!Array.isArray(menu)) {
      return res.status(400).json({ ok: false, error: "expected an array of menu items" });
    }
    await redis.set("menu", menu);
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
}
