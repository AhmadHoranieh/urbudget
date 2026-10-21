import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("upgrades existing sync and refund records without changing ciphertext references or legacy generation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).sort().filter((name) => name < "0009"))
      db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.exec(`
      INSERT INTO users (id,email,created_at) VALUES ('usr_legacy','legacy@example.com','2026-01-01');
      INSERT INTO sync_keys (user_id,salt,key_check,created_at) VALUES ('usr_legacy','original-salt','original-check','2026-01-01');
      INSERT INTO sync_budgets (user_id,budget_id,revision,object_key,size,updated_at)
        VALUES ('usr_legacy','b',42,'original-ciphertext-object',123,'2026-01-01');
      INSERT INTO licenses (id,key,email,status,order_id,created_at,refunded_at)
        VALUES ('lic_refunded','UB-REFUNDED','legacy@example.com','refunded','order_refunded','2026-01-01','2026-02-01');
      INSERT INTO licenses (id,key,email,status,order_id,created_at)
        VALUES ('lic_active','UB-ACTIVE','legacy@example.com','active','order_active','2026-01-01');
    `);
    db.exec(readFileSync(new URL("0009_lifecycle_guards.sql", directory), "utf8"));
    expect(db.prepare("SELECT generation,salt,key_check FROM sync_keys").get()).toEqual({ generation: 0, salt: "original-salt", key_check: "original-check" });
    expect(db.prepare("SELECT revision,object_key,size FROM sync_budgets").get()).toEqual({ revision: 42, object_key: "original-ciphertext-object", size: 123 });
    expect(db.prepare("SELECT * FROM refunded_orders").all()).toEqual([{ order_id: "order_refunded", refunded_at: "2026-02-01" }]);
    expect(db.prepare("SELECT * FROM sync_object_garbage").all()).toEqual([]);
    db.exec("DELETE FROM users WHERE id = 'usr_legacy'");
    expect(db.prepare("SELECT object_key FROM sync_object_garbage").all()).toEqual([{ object_key: "original-ciphertext-object" }]);
  } finally {
    db.close();
  }
});
