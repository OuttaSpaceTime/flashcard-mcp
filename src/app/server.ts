#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createClient, setDb } from "../db/client.js";
import { normalizeDates } from "../db/normalize.js";
import { createHandlers, type Handler } from "./handlers.js";

/**
 * The Omvida app's connection to the deck: newline-delimited JSON over stdio.
 *
 *   -> {"id": 1, "method": "nextCard", "params": {"sessionId": "..."}}
 *   <- {"id": 1, "result": {...}}            or {"id": 1, "error": {"message": "..."}}
 *
 * plus one unsolicited line at start, {"ready": true}, once the database is
 * open. The app runs this as a QML Process for as long as it is open.
 *
 * Not MCP, which would also work over stdio: an MCP client in QML means
 * implementing the initialize handshake and tool-result envelopes by hand, for
 * nothing the app needs. Not the CLI per call either: each start costs about
 * a second of tsx, and the session cache lives here (session-service.ts).
 *
 * Requests run concurrently, so a three-second grade never holds up anything
 * else; the app orders the calls that depend on each other. stdout is the
 * protocol, so anything else that would print goes to stderr.
 */

export async function dispatch(
  handlers: Record<string, Handler>,
  line: string
): Promise<string | null> {
  if (line.trim() === "") return null;
  let req: { id?: unknown; method?: unknown; params?: unknown };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    return JSON.stringify({ id: null, error: { message: "request is not JSON" } });
  }
  const id = typeof req.id === "number" || typeof req.id === "string" ? req.id : null;
  const method = typeof req.method === "string" ? req.method : "";
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
  if (handler === undefined) {
    return JSON.stringify({ id, error: { message: `unknown method: ${method}` } });
  }
  const params =
    req.params != null && typeof req.params === "object" && !Array.isArray(req.params)
      ? (req.params as Record<string, unknown>)
      : {};
  try {
    const result = await handler(params);
    return JSON.stringify({ id, result: result ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ id, error: { message } });
  }
}

async function main(): Promise<void> {
  console.log = (...args: unknown[]) => console.error(...args);
  const db = createClient();
  setDb(db);
  await normalizeDates(db);
  const handlers = createHandlers();

  const write = (s: string): void => {
    process.stdout.write(s + "\n");
  };
  write(JSON.stringify({ ready: true }));

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void dispatch(handlers, line).then((out) => {
      if (out != null) write(out);
    });
  });
  // The app quitting closes stdin; that is the whole shutdown protocol.
  rl.on("close", () => process.exit(0));
}

const isMain = /src[/\\]app[/\\]server\.[jt]s$|build[/\\]app[/\\]server\.js$/.test(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
