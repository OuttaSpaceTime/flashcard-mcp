import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGradePrompt,
  gradeArgv,
  gradeMessage,
  parseGradeOutput,
  startClaude,
  Grader,
  GRADE_SCHEMA,
  type ClaudeProcess,
  type ClaudeStarter,
  type RunResult,
} from "../../src/core/grading.js";

function envelope(structured: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(structured),
    structured_output: structured,
    ...extra,
  });
}

interface FakeClaude extends ClaudeProcess {
  sent: string | null;
  killed: boolean;
  exited: boolean;
  finish(r: RunResult): void;
  die(): void;
}

/** A claude that answers when the test says so, recording what it was sent. */
function fakeClaudes(): { start: ClaudeStarter; procs: FakeClaude[] } {
  const procs: FakeClaude[] = [];
  const start: ClaudeStarter = () => {
    let settle: { resolve: (r: RunResult) => void; reject: (e: Error) => void } | null = null;
    const p: FakeClaude = {
      sent: null,
      killed: false,
      exited: false,
      send(stdin) {
        if (p.killed) return Promise.reject(new Error("grade cancelled"));
        p.sent = stdin;
        return new Promise((resolve, reject) => (settle = { resolve, reject }));
      },
      kill() {
        p.killed = true;
        p.exited = true;
        settle?.reject(new Error("grade cancelled"));
      },
      finish(r) {
        p.exited = true;
        settle?.resolve(r);
      },
      die() {
        p.exited = true;
      },
    };
    procs.push(p);
    return p;
  };
  return { start, procs };
}

const ok = (rating: number): RunResult => ({ code: 0, stdout: envelope({ rating, reason: "Fine.", quality_issue: "none" }), stderr: "" });
const card = (answer: string) => ({ front: "Q", back: "A", answer });

describe("grading", () => {
  it("runs claude bare: no tools, no MCP, no settings, no saved session", () => {
    const argv = gradeArgv();
    expect(argv).toContain("-p");
    expect(argv.slice(argv.indexOf("--input-format"), argv.indexOf("--input-format") + 2)).toEqual(["--input-format", "stream-json"]);
    expect(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "sonnet"]);
    expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.slice(argv.indexOf("--setting-sources"), argv.indexOf("--setting-sources") + 2)).toEqual([
      "--setting-sources",
      "",
    ]);
    expect(argv).toContain("--no-session-persistence");
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1])).toEqual(GRADE_SCHEMA);
  });

  it("puts front, back and answer in the prompt, in tagged blocks", () => {
    const prompt = buildGradePrompt({ front: "Q<b>1</b>", back: "A", answer: "my answer" });
    expect(prompt).toContain("<front>\nQ<b>1</b>\n</front>");
    expect(prompt).toContain("<back>\nA\n</back>");
    expect(prompt).toContain("<developer_answer>\nmy answer\n</developer_answer>");
  });

  it("sends the prompt as one stream-json user message", () => {
    const line = gradeMessage(card("my answer"));
    expect(line.endsWith("\n")).toBe(true);
    const msg = JSON.parse(line) as { type: string; message: { role: string; content: string } };
    expect(msg.type).toBe("user");
    expect(msg.message.role).toBe("user");
    expect(msg.message.content).toBe(buildGradePrompt(card("my answer")));
  });

  it("finds the result line in stream-json output", () => {
    const out = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      envelope({ rating: 1, reason: "Wrong.", quality_issue: "none" }),
      "",
    ].join("\n");
    expect(parseGradeOutput(out).rating).toBe(1);
  });

  it("parses the structured output", () => {
    const out = parseGradeOutput(envelope({ rating: 2, reason: " Missing the TTL. ", quality_issue: "none" }));
    expect(out).toEqual({ rating: 2, reason: "Missing the TTL.", quality: null });
  });

  it("falls back to the result string when structured_output is absent", () => {
    const raw = JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ rating: 3, reason: "Right.", quality_issue: "none" }) });
    expect(parseGradeOutput(raw).rating).toBe(3);
  });

  it("reports a card quality issue with its detail", () => {
    const out = parseGradeOutput(
      envelope({ rating: 3, reason: "Right.", quality_issue: "two_questions", quality_detail: "Asks two things." })
    );
    expect(out.quality).toEqual({ issue: "two_questions", detail: "Asks two things." });
  });

  it("drops an unknown quality issue rather than inventing one", () => {
    const out = parseGradeOutput(envelope({ rating: 3, reason: "Right.", quality_issue: "made_up" }));
    expect(out.quality).toBeNull();
  });

  it("rejects an invalid rating, a missing reason, an error envelope and non-JSON", () => {
    expect(() => parseGradeOutput(envelope({ rating: 5, reason: "x", quality_issue: "none" }))).toThrow(/invalid rating/);
    expect(() => parseGradeOutput(envelope({ rating: 3, reason: "  ", quality_issue: "none" }))).toThrow(/no reason/);
    expect(() => parseGradeOutput(JSON.stringify({ type: "result", is_error: true, result: "rate limited" }))).toThrow(/rate limited/);
    expect(() => parseGradeOutput("not json")).toThrow(/no JSON/);
  });

  it("boots one spare on prepare, grades on it, and boots the next", async () => {
    const { start, procs } = fakeClaudes();
    const g = new Grader(start);
    g.prepare();
    g.prepare();
    expect(procs).toHaveLength(1);
    const first = g.grade(g.claim(), card("draft"));
    expect(procs[0].sent).toBe(gradeMessage(card("draft")));
    expect(procs).toHaveLength(2);
    procs[0].finish(ok(2));
    expect((await first).rating).toBe(2);
    g.prepare();
    expect(procs).toHaveLength(2);
  });

  it("grades on a fresh claude when no spare was booted, or the spare died", async () => {
    const { start, procs } = fakeClaudes();
    const g = new Grader(start);
    g.prepare();
    procs[0].die();
    const p = g.grade(g.claim(), card("x"));
    expect(procs[0].sent).toBeNull();
    expect(procs[1].sent).toBe(gradeMessage(card("x")));
    procs[1].finish(ok(3));
    expect((await p).rating).toBe(3);
  });

  it("a newer claim ends the grade still running, even one not yet sent", async () => {
    const { start, procs } = fakeClaudes();
    const g = new Grader(start);
    const older = g.claim();
    const newer = g.claim();
    expect(older.exited).toBe(true);
    await expect(g.grade(older, card("half"))).rejects.toThrow(/cancelled/);
    const running = g.grade(newer, card("half and more"));
    expect(procs[1].sent).toBe(gradeMessage(card("half and more")));
    procs[1].finish(ok(3));
    expect((await running).rating).toBe(3);
  });

  it("endGrade ends the running grade and keeps the spare; close ends both", async () => {
    const { start, procs } = fakeClaudes();
    const g = new Grader(start);
    const running = g.grade(g.claim(), card("x"));
    g.endGrade();
    await expect(running).rejects.toThrow(/cancelled/);
    expect(procs.map((p) => p.killed)).toEqual([true, false]);
    g.close();
    expect(procs.map((p) => p.killed)).toEqual([true, true]);
  });

  it("surfaces the first stderr line when claude fails with no result", async () => {
    const { start, procs } = fakeClaudes();
    const g = new Grader(start);
    const p = g.grade(g.claim(), card("x"));
    procs[0].finish({ code: 1, stdout: JSON.stringify({ type: "system", subtype: "init" }), stderr: "Not logged in\nmore" });
    await expect(p).rejects.toThrow("grader exited 1: Not logged in");
  });
});

// The real process handling, against a stand-in for `claude` that waits for
// stdin to close, as the real one does with stream-json input.
describe("startClaude", () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const fake = join(dir, "claude");
  writeFileSync(
    fake,
    `#!/bin/sh\ninput="$(cat)"\ncase "$input" in *slow*) exec sleep 5 ;; esac\nprintf '%s\\n' '{"type":"system","subtype":"init"}'\nprintf '{"type":"result","is_error":false,"result":"%s"}\\n' "$(printf '%s' "$input" | wc -c)"\n`
  );
  chmodSync(fake, 0o755);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("waits for the prompt, then returns what claude printed", async () => {
    const p = startClaude([], fake);
    await new Promise((r) => setTimeout(r, 200));
    expect(p.exited).toBe(false);
    const r = await p.send("hello", 5000);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"result":"5"');
    expect(p.exited).toBe(true);
  });

  it("a killed claude refuses its prompt instead of taking the server down", async () => {
    const p = startClaude([], fake);
    p.kill();
    expect(p.exited).toBe(true);
    await expect(p.send("hello", 5000)).rejects.toThrow(/cancelled/);
  });

  it("a kill during the grade rejects it", async () => {
    const p = startClaude([], fake);
    const pending = p.send("slow", 5000);
    setTimeout(() => p.kill(), 100);
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
