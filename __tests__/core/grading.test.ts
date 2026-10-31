import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildGradePrompt,
  gradeRequest,
  parseGradeMessage,
  Grader,
  GRADE_SCHEMA,
  type GradeCall,
} from "../../src/core/grading.js";

type Message = Anthropic.Messages.Message;
type Body = Anthropic.Messages.MessageCreateParamsNonStreaming;

function reply(verdict: unknown, extra: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: typeof verdict === "string" ? verdict : JSON.stringify(verdict) }],
    stop_reason: "end_turn",
    ...extra,
  } as Message;
}

interface Pending {
  body: Body;
  signal: AbortSignal;
  answer(m: Message): void;
  fail(e: unknown): void;
}

/** An API that answers when the test says so, recording what it was sent. */
function fakeApi(): { call: GradeCall; calls: Pending[] } {
  const calls: Pending[] = [];
  const call: GradeCall = (body, signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
      calls.push({ body, signal, answer: resolve, fail: reject });
    });
  return { call, calls };
}

const ok = (rating: number) => reply({ rating, reason: "Fine." });
const card = (answer: string) => ({ front: "Q", back: "A", answer });

describe("grading", () => {
  it("asks Haiku at low effort with no tools, for the rating as structured output", () => {
    const req = gradeRequest(card("my answer"));
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.tools).toBeUndefined();
    expect(req.thinking).toBeUndefined();
    expect(req.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: GRADE_SCHEMA } });
    expect(Object.keys(GRADE_SCHEMA.properties)).toEqual(["rating", "reason"]);
    expect(req.messages).toEqual([{ role: "user", content: buildGradePrompt(card("my answer")) }]);
    const system = req.system as Anthropic.Messages.TextBlockParam[];
    expect(system[0].text).toMatch(/fixed rubric/);
  });

  it("puts front, back and answer in the prompt, in tagged blocks", () => {
    const prompt = buildGradePrompt({ front: "Q<b>1</b>", back: "A", answer: "my answer" });
    expect(prompt).toContain("<front>\nQ<b>1</b>\n</front>");
    expect(prompt).toContain("<back>\nA\n</back>");
    expect(prompt).toContain("<developer_answer>\nmy answer\n</developer_answer>");
  });

  it("parses the structured output", () => {
    const out = parseGradeMessage(reply({ rating: 2, reason: " Missing the TTL. " }));
    expect(out).toEqual({ rating: 2, reason: "Missing the TTL." });
  });

  it("reads past a thinking block to the text", () => {
    const m = reply({ rating: 3, reason: "Right." });
    m.content = [{ type: "thinking", thinking: "", signature: "s" } as Anthropic.Messages.ContentBlock, ...m.content];
    expect(parseGradeMessage(m).rating).toBe(3);
  });

  it("rejects an invalid rating, a missing reason, non-JSON, a cut-off reply and a refusal", () => {
    expect(() => parseGradeMessage(reply({ rating: 5, reason: "x" }))).toThrow(/invalid rating/);
    expect(() => parseGradeMessage(reply({ rating: 3, reason: "  " }))).toThrow(/no reason/);
    expect(() => parseGradeMessage(reply("not json"))).toThrow(/no JSON/);
    expect(() => parseGradeMessage(reply("{\"rating\": 3", { stop_reason: "max_tokens" }))).toThrow(/cut off/);
    const refused = reply("", { stop_reason: "refusal" });
    (refused as unknown as { stop_details: unknown }).stop_details = { type: "refusal", category: "cyber", explanation: null };
    expect(() => parseGradeMessage(refused)).toThrow("grader declined this card (cyber)");
  });

  it("grades on one request and returns its verdict", async () => {
    const { call, calls } = fakeApi();
    const g = new Grader(call);
    const p = g.grade(g.claim(), card("draft"));
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual(gradeRequest(card("draft")));
    calls[0].answer(ok(2));
    expect((await p).rating).toBe(2);
  });

  it("asks Sonnet once when Haiku declines, and shows a second decline", async () => {
    const { call, calls } = fakeApi();
    const g = new Grader(call);
    const declined = reply("", { stop_reason: "refusal" });
    const p = g.grade(g.claim(), card("csrf"));
    calls[0].answer(declined);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body.model).toBe("claude-sonnet-5-5");
    calls[1].answer(ok(3));
    expect((await p).rating).toBe(3);

    const q = g.grade(g.claim(), card("csrf again"));
    calls[2].answer(declined);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    calls[3].answer(declined);
    await expect(q).rejects.toThrow(/declined/);
  });

  it("a newer claim aborts the grade still running, even one not yet sent", async () => {
    const { call, calls } = fakeApi();
    const g = new Grader(call);
    const older = g.claim();
    const newer = g.claim();
    expect(older.signal.aborted).toBe(true);
    await expect(g.grade(older, card("half"))).rejects.toThrow(/cancelled/);
    expect(calls).toHaveLength(0);
    const running = g.grade(newer, card("half and more"));
    const third = g.claim();
    await expect(running).rejects.toThrow(/cancelled/);
    expect(calls[0].signal.aborted).toBe(true);
    const last = g.grade(third, card("whole"));
    calls[1].answer(ok(3));
    expect((await last).rating).toBe(3);
  });

  it("endGrade aborts the running grade", async () => {
    const { call, calls } = fakeApi();
    const g = new Grader(call);
    const running = g.grade(g.claim(), card("x"));
    g.endGrade();
    await expect(running).rejects.toThrow(/cancelled/);
    expect(calls[0].signal.aborted).toBe(true);
  });

  it("says in one line what went wrong with the API", async () => {
    const { call, calls } = fakeApi();
    const g = new Grader(call);
    const headers = new Headers();
    const fail = async (err: unknown) => {
      const p = g.grade(g.claim(), card("x"));
      calls[calls.length - 1].fail(err);
      return p.then(() => "", (e: Error) => e.message);
    };
    expect(await fail(new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, headers))).toBe(
      "grader's API key was refused"
    );
    expect(await fail(new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "bad schema" } }, undefined, headers))).toBe(
      "grader failed (400): bad schema"
    );
    expect(await fail(new Anthropic.APIConnectionError({ message: "down" }))).toBe("grader could not reach the Claude API");
    expect(await fail(new Error("no API key: the deck server needs ANTHROPIC_API_KEY to grade"))).toMatch(/ANTHROPIC_API_KEY/);
  });
});
