// In-memory stand-ins for the Worker's bindings: D1 on node:sqlite, R2 on a Map. Enough of each
// API for the code under test; not a general emulator.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/env";

class Statement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params);
  }
  // node:sqlite treats D1's numbered `?1` parameters as named ones, so they become `:p1`.
  private get statement() {
    return this.db.prepare(this.sql.replace(/\?(\d+)/g, ":p$1"));
  }
  private get values() {
    const used = new Set([...this.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
    const named: Record<string, unknown> = {};
    this.params.forEach((p, i) => {
      if (used.has(i + 1)) named[`p${i + 1}`] = p === undefined ? null : typeof p === "boolean" ? Number(p) : p;
    });
    return [named] as never[];
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }
  async all<T>() {
    return { results: this.statement.all(...this.values).map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = this.statement.all(...this.values).map((row) => ({ ...row }));
      const changes = this.db.prepare("SELECT changes() AS n").get()!.n;
      return { success: true, results, meta: { changes: Number(changes), last_row_id: 0 } };
    }
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

export function fakeD1(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  const db = {
    sqlite,
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        // Execute the whole synthetic transaction without yielding between its
        // statements, matching D1 batch isolation from concurrent requests.
        for (const s of statements) results.push(s.runSync());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return db as unknown as D1Database & { sqlite: DatabaseSync };
}

export function fakeR2(): R2Bucket & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const toBytes = async (value: unknown): Promise<Uint8Array> => {
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
  };
  const bucket = {
    objects,
    async put(key: string, value: unknown) {
      objects.set(key, await toBytes(value));
      return { key };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        key,
        size: bytes.byteLength,
        httpEtag: `"${bytes.byteLength}"`,
        range: undefined,
        body: new Response(bytes).body,
        writeHttpMetadata() {},
        arrayBuffer: async () => bytes.slice().buffer,
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return bucket as unknown as R2Bucket & { objects: Map<string, Uint8Array> };
}

export interface TestEnv extends Env {
  DB: ReturnType<typeof fakeD1>;
  SYNC: ReturnType<typeof fakeR2>;
  RELEASES: ReturnType<typeof fakeR2>;
}

export async function testEnv(): Promise<TestEnv> {
  return {
    ASSETS: { fetch: async () => new Response("static", { status: 200 }) } as unknown as Fetcher,
    DB: fakeD1(),
    SYNC: fakeR2(),
    RELEASES: fakeR2(),
    APP_URL: "http://localhost",
    EMAIL_FROM: "UrBudget <hello@urbudget.app>",
    SUPPORT_EMAIL: "support@urbudget.app",
    BILLING_ENV: "sandbox",
    POLAR_PRODUCT_SYNC: "prod-sync",
    POLAR_ACCESS_TOKEN: "polar_oat_test",
    POLAR_WEBHOOK_SECRET: "whsec_dGVzdC13ZWJob29rLXNlY3JldC1rZXk",
    DEV_LOGIN_CODES: "1",
  };
}
