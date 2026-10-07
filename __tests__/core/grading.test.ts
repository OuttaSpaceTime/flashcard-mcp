import { describe, it, expect } from "vitest";
import {
  buildGradePrompt,
  gradeAnswer,
  gradeArgv,
  parseGradeOutput,
  GRADE_SCHEMA,
  type ClaudeRunner,
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

describe("grading", () => {
  it("runs claude bare: no tools, no MCP, no settings, no saved session", () => {
    const argv = gradeArgv();
    expect(argv).toContain("-p");
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

  it("parses the structured output", () => {
    const out = parseGradeOutput(envelope({ rating: 2, reason: " Missing the TTL. ", quality_issue: "none" }));
    expect(out).toEqual({ rating: 2, reason: "Missing the TTL.", quality: null });
  });

  it("falls back to the result string when structured_output is absent", () => {
    const raw = JSON.stringify({ is_error: false, result: JSON.stringify({ rating: 3, reason: "Right.", quality_issue: "none" }) });
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
    expect(() => parseGradeOutput(JSON.stringify({ is_error: true, result: "rate limited" }))).toThrow(/rate limited/);
    expect(() => parseGradeOutput("not json")).toThrow(/no JSON/);
  });

  it("refuses to grade an empty answer without starting claude", async () => {
    let ran = false;
    const runner: ClaudeRunner = async () => {
      ran = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(gradeAnswer({ front: "Q", back: "A", answer: "   " }, runner)).rejects.toThrow(/empty/);
    expect(ran).toBe(false);
  });

  it("passes the prompt on stdin and returns the suggestion", async () => {
    let stdinSeen = "";
    const runner: ClaudeRunner = async (_argv, stdin) => {
      stdinSeen = stdin;
      return { code: 0, stdout: envelope({ rating: 4, reason: "Exact.", quality_issue: "none" }), stderr: "" };
    };
    const out = await gradeAnswer({ front: "Q", back: "A", answer: "A" }, runner);
    expect(stdinSeen).toContain("<developer_answer>\nA\n</developer_answer>");
    expect(out.rating).toBe(4);
  });

  it("surfaces the first stderr line when claude fails with no output", async () => {
    const runner: ClaudeRunner = async () => ({ code: 1, stdout: "", stderr: "Not logged in\nmore" });
    await expect(gradeAnswer({ front: "Q", back: "A", answer: "x" }, runner)).rejects.toThrow(
      "grader exited 1: Not logged in"
    );
  });
});
