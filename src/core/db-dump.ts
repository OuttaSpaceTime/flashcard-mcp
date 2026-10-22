import Database from "better-sqlite3";
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { dirname } from "path";

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "NULL";
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
    const buf = Buffer.isBuffer(v) ? v : Buffer.from(v);
    return `X'${buf.toString("hex")}'`;
  }
  return escapeString(String(v));
}

/** Table and row counts of a dumped or restored database. */
export interface DbFileStats {
  tables: number;
  rows: number;
}

export function dumpDatabase(dbPath: string, outPath: string): DbFileStats {
  if (!existsSync(dbPath)) {
    throw new Error(`Source database not found: ${dbPath}`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const parts: string[] = [];
    parts.push("PRAGMA foreign_keys=OFF;");
    parts.push("BEGIN TRANSACTION;");

    const objects = db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE sql IS NOT NULL
           AND name NOT LIKE 'sqlite_%'
         ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'view' THEN 3 WHEN 'trigger' THEN 4 ELSE 5 END`,
      )
      .all() as MasterRow[];

    const tables = objects.filter((o) => o.type === "table");

    for (const t of tables) {
      parts.push(`DROP TABLE IF EXISTS ${quoteIdent(t.name)};`);
    }
    for (const o of objects) {
      parts.push(`${o.sql};`);
    }

    let totalRows = 0;
    for (const t of tables) {
      const colsInfo = db
        .prepare(`PRAGMA table_info(${quoteIdent(t.name)})`)
        .all() as Array<{ name: string }>;
      const colNames = colsInfo.map((c) => c.name);
      const colList = colNames.map(quoteIdent).join(", ");
      const select = db.prepare(
        `SELECT ${colList} FROM ${quoteIdent(t.name)}`,
      );
      for (const row of select.iterate() as IterableIterator<
        Record<string, unknown>
      >) {
        const values = colNames.map((c) => encodeValue(row[c])).join(", ");
        parts.push(
          `INSERT INTO ${quoteIdent(t.name)} (${colList}) VALUES (${values});`,
        );
        totalRows++;
      }
    }

    // The schema fingerprint (src/db/schema-sync.ts): without it a restored
    // database reads as never synced, and the next start pushes and backs up.
    parts.push(`PRAGMA user_version=${Number(db.pragma("user_version", { simple: true }))};`);
    parts.push("COMMIT;");

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, parts.join("\n") + "\n", "utf-8");
    return { tables: tables.length, rows: totalRows };
  } finally {
    db.close();
  }
}

export function restoreDatabase(
  dbPath: string,
  sqlPath: string,
  { force = false }: { force?: boolean } = {},
): DbFileStats {
  if (!existsSync(sqlPath)) {
    throw new Error(`SQL dump not found: ${sqlPath}`);
  }
  if (existsSync(dbPath)) {
    if (!force) {
      throw new Error(
        `Refusing to overwrite existing database: ${dbPath} (pass force:true / --force to override)`,
      );
    }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(dbPath + suffix, { force: true });
    }
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const sql = readFileSync(sqlPath, "utf-8");

  const db = new Database(dbPath);
  try {
    db.exec(sql);
    const tableNames = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    let rows = 0;
    for (const name of tableNames) {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`)
        .get() as { n: number };
      rows += r.n;
    }
    return { tables: tableNames.length, rows };
  } finally {
    db.close();
  }
}
