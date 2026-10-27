// One Durable Object ("shop") runs every API request. Single-threaded + synchronous SQLite
// means two devices can never read-modify-write the same order list or print job at once.
import { DurableObject } from "cloudflare:workers";
import { handleApiRequest } from "./api-router.js";
import { SqliteStore } from "./sqlite-store.js";

export class ShopDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new SqliteStore(ctx.storage.sql);
  }

  async fetch(request) {
    return handleApiRequest(request, { store: this.store, env: this.env });
  }
}
