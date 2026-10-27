// A tiny Redis-compatible store on top of a Durable Object's SQLite database.
//
// It implements only what the API handlers use: get, set (with { ex }), del, expire, hset,
// hgetall and mget. Values are stored as JSON text, so strings, numbers, arrays and objects
// round-trip exactly like they did through @upstash/redis.
//
// Why this is safe from lost updates: ctx.storage.sql is synchronous, so each handler's reads
// and writes run to completion without another request interleaving (one Durable Object =
// one single-threaded writer). That is stronger than the old Upstash setup, where two
// requests could read the same array and overwrite each other.
//
// `sql` must provide exec(query, ...bindings) returning an object with toArray().

export class SqliteStore {
  constructor(sql, now = Date.now) {
    this.sql = sql;
    this.now = now;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, exp INTEGER)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS h (key TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, field))",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS hexp (key TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
  }

  rows(query, ...bindings) {
    return this.sql.exec(query, ...bindings).toArray();
  }

  async get(key) {
    const [row] = this.rows("SELECT value, exp FROM kv WHERE key = ?", key);
    if (!row) return null;
    if (row.exp != null && row.exp <= this.now()) {
      this.sql.exec("DELETE FROM kv WHERE key = ?", key);
      return null;
    }
    return JSON.parse(row.value);
  }

  async mget(...keys) {
    const list = keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys;
    const result = [];
    for (const key of list) result.push(await this.get(key));
    return result;
  }

  async set(key, value, options = {}) {
    const ex = options && Number(options.ex) > 0 ? this.now() + Number(options.ex) * 1000 : null;
    this.sql.exec(
      "INSERT INTO kv (key, value, exp) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, exp = excluded.exp",
      key,
      JSON.stringify(value),
      ex,
    );
    return "OK";
  }

  async del(key) {
    this.sql.exec("DELETE FROM kv WHERE key = ?", key);
    this.sql.exec("DELETE FROM h WHERE key = ?", key);
    this.sql.exec("DELETE FROM hexp WHERE key = ?", key);
    return 1;
  }

  async expire(key, seconds) {
    const exp = this.now() + Number(seconds) * 1000;
    const [kvRow] = this.rows("SELECT 1 AS ok FROM kv WHERE key = ?", key);
    const [hashRow] = this.rows("SELECT 1 AS ok FROM h WHERE key = ? LIMIT 1", key);
    if (kvRow) this.sql.exec("UPDATE kv SET exp = ? WHERE key = ?", exp, key);
    if (hashRow) {
      this.sql.exec(
        "INSERT INTO hexp (key, exp) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET exp = excluded.exp",
        key,
        exp,
      );
    }
    return kvRow || hashRow ? 1 : 0;
  }

  purgeHashIfExpired(key) {
    const [row] = this.rows("SELECT exp FROM hexp WHERE key = ?", key);
    if (row && row.exp <= this.now()) {
      this.sql.exec("DELETE FROM h WHERE key = ?", key);
      this.sql.exec("DELETE FROM hexp WHERE key = ?", key);
    }
  }

  async hset(key, values) {
    this.purgeHashIfExpired(key);
    let added = 0;
    for (const [field, value] of Object.entries(values || {})) {
      this.sql.exec(
        "INSERT INTO h (key, field, value) VALUES (?, ?, ?) ON CONFLICT(key, field) DO UPDATE SET value = excluded.value",
        key,
        String(field),
        JSON.stringify(value),
      );
      added += 1;
    }
    return added;
  }

  async hgetall(key) {
    this.purgeHashIfExpired(key);
    const rows = this.rows("SELECT field, value FROM h WHERE key = ?", key);
    if (!rows.length) return null;
    const result = {};
    for (const row of rows) result[row.field] = JSON.parse(row.value);
    return result;
  }

  // ---- backup / migration helpers (used by the token-protected admin endpoints) ----

  exportAll() {
    const kv = {};
    for (const row of this.rows("SELECT key, value, exp FROM kv")) {
      if (row.exp != null && row.exp <= this.now()) continue;
      kv[row.key] = { value: JSON.parse(row.value), exp: row.exp };
    }
    const hashes = {};
    for (const row of this.rows("SELECT key, field, value FROM h")) {
      (hashes[row.key] ||= {})[row.field] = JSON.parse(row.value);
    }
    const hashExpiry = {};
    for (const row of this.rows("SELECT key, exp FROM hexp")) hashExpiry[row.key] = row.exp;
    return { kv, hashes, hashExpiry };
  }

  async importAll(data) {
    let count = 0;
    for (const [key, entry] of Object.entries((data && data.kv) || {})) {
      const value = entry && typeof entry === "object" && "value" in entry ? entry.value : entry;
      const exp = entry && typeof entry === "object" && entry.exp != null ? Number(entry.exp) : null;
      this.sql.exec(
        "INSERT INTO kv (key, value, exp) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, exp = excluded.exp",
        key,
        JSON.stringify(value),
        exp,
      );
      count += 1;
    }
    for (const [key, fields] of Object.entries((data && data.hashes) || {})) {
      await this.hset(key, fields);
      count += 1;
    }
    for (const [key, exp] of Object.entries((data && data.hashExpiry) || {})) {
      this.sql.exec(
        "INSERT INTO hexp (key, exp) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET exp = excluded.exp",
        key,
        Number(exp),
      );
    }
    return count;
  }
}
