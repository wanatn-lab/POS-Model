import { DatabaseSync } from "node:sqlite";

// Makes node:sqlite look like a Durable Object's ctx.storage.sql (exec(query, ...bindings).toArray()).
export function fakeSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = statement.all(...bindings);
        return { toArray: () => rows };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}
