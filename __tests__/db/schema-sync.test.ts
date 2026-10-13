import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getDb } from "../../src/db/client.js";
import { schemaVersion, syncSchema } from "../../src/db/schema-sync.js";

describe("schema sync", () => {
  it("pushes once per schema, backing the database up first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-sync-"));
    const schema = join(dir, "schema.prisma");
    const dbFile = join(dir, "deck.db");
    writeFileSync(schema, "model A { id Int @id }\n");
    writeFileSync(dbFile, "not empty");
    const pushed: string[] = [];
    const opts = { schemaPath: schema, dbUrl: `file:${dbFile}`, push: (u: string) => void pushed.push(u) };
    const db = getDb();
    await db.$executeRawUnsafe("PRAGMA user_version = 0");

    expect(await syncSchema(db, opts)).toBe(true);
    expect(pushed).toEqual([`file:${dbFile}`]);
    expect(readdirSync(dir).filter((f) => f.startsWith("deck.db.bak-") && f.endsWith("-schema"))).toHaveLength(1);
    const v = await db.$queryRawUnsafe<{ user_version: number | bigint }[]>("PRAGMA user_version");
    expect(Number(v[0].user_version)).toBe(schemaVersion("model A { id Int @id }\n"));

    expect(await syncSchema(db, opts)).toBe(false);
    expect(pushed).toHaveLength(1);

    writeFileSync(schema, "model A { id Int @id }\nmodel B { id Int @id }\n");
    expect(await syncSchema(db, opts)).toBe(true);
    expect(pushed).toHaveLength(2);
  });

  it("fingerprints are positive 31-bit numbers, never 0", () => {
    for (const s of ["", "a", "model X {}"]) {
      const v = schemaVersion(s);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(2 ** 31);
    }
  });
});
