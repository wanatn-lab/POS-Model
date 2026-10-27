import { redis } from "./_redis.js";

// Seed data — matches what was already live on the site before this migration,
// so the very first request doesn't show an empty menu.
const SEED_MENU = [
  { id: "m1", name: "ข้าวผัดกระเพราหมูสับ", price: 59, desc: "เผ็ดกำลังดี ใส่ไข่ดาว", image: "https://images.unsplash.com/photo-1626200419199-391ae4be7a41?w=500&q=60" },
  { id: "m2", name: "ก๋วยเตี๋ยวเรือเนื้อ", price: 45, desc: "น้ำซุปเข้มข้น เส้นเล็ก", image: "https://images.unsplash.com/photo-1585032226651-759b368d7246?w=500&q=60" },
  { id: "m3", name: "ชาเย็น", price: 35, desc: "หวานมัน เย็นชื่นใจ", image: "https://images.unsplash.com/photo-1558857563-b371033873b8?w=500&q=60", available: true },
];

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
