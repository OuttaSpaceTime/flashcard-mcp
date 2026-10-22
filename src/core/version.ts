import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../db/client.js";

/** package.json's version, the one the MCP server and the CLI report. */
export const PACKAGE_VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))).version;
