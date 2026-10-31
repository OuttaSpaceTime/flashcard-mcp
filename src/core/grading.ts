import Anthropic from "@anthropic-ai/sdk";
import type { Grade } from "ts-fsrs";
import { isGrade } from "./scheduler.js";

/**
 * Suggested ratings for typed answers, from the Claude API.
 *
 * This is the /study skill's evaluation step (rate on the unaided answer, one or
 * two sentences of reason) moved out of a chat session so a GUI can use it: the
 * Omvida app shows the suggestion, and the developer accepts it or overrides it.
 * The suggestion is never submitted here — `submitReview` stays the only write,
 * and it takes whatever rating the developer finally chose.
 *
 * The rubric is fixed, for the same reason as in the skill: the ratings produce
 * the true-retention number that tunes study difficulty, so the rubric must not
 * move with that number, or the cheapest way to "fix" low retention would be to
 * grade more leniently.
 *
 * One Messages API call per grade: no tools, the card back the only thing it
 * judges against, the verdict a structured output against GRADE_SCHEMA. Haiku,
 * at effort low with thinking left adaptive (Haiku 5.5's advice over turning it
 * off): with the answer key in the prompt, rating is reading comprehension.
 * Compared with Sonnet on 30 real cards (2026-10-30, through `claude -p`): the
 * same pass/fail on 28, and on the 2 it differed Haiku was the stricter and
 * arguably right. Haiku has no server-side refusal fallback, and a deck of
 * web-security cards is what a cyber classifier may decline: a declined grade
 * is asked of Sonnet once (FALLBACK_MODEL), which declines fewer benign
 * requests. Declined again, it shows the decline and is rated by hand.
 *
 * Grading only rates. It also judged the card's quality until 2026-10-31; that
 * moved out of the study loop: a check the developer asks for (Omvida's
 * Ctrl+Q, the study repo's /study-card-check) and a gate on every card written
 * in the study repo (its card-quality hook), so a flawed card is fixed by
 * Claude Code rather than flagged to the developer mid-review.
 *
 * It ran on `claude -p` first, and was moved off it (2026-10-30) because a
 * grade took about three seconds there: a second of the CLI starting (hidden
 * behind a spare process booted ahead), and a second turn the CLI spends on
 * `--json-schema`. The API answers in one round trip: Haiku in 1.0-1.2s, the
 * first grade of a server's life 2.6s with the connection (Sonnet took
 * 1.5-2.5s; both measured on the fixture deck, 2026-10-30/31). The cost is that grades bill an
 * API key rather than the Claude subscription (Haiku: about $0.00015 each);
 * the key comes from the environment (ANTHROPIC_API_KEY), which Omvida's deck
 * script fills from the login keyring.
 *
 * The app grades once per card, on the reveal (it graded on every pause in
 * the typing while grades were free). The `Grader` still runs at most one,
 * aborting a grade the next card or a newer request makes moot, so nothing
 * is billed for a verdict nobody will see. Each grade is a fresh request,
 * never a turn added to the last one: an earlier draft and its verdict must
 * not sway the rating.
 */

const GRADE_MODEL = "claude-haiku-5-5";
const FALLBACK_MODEL = "claude-sonnet-5-5";
// One attempt's deadline, and one retry (on a 429, a 5xx or a dropped
// connection): a grade gives up within a minute, under the app's request
// timeout (Omvida's Config.requestTimeout).
const GRADE_TIMEOUT_MS = 25_000;
const GRADE_RETRIES = 1;

export interface GradeInput {
  front: string;
  back: string;
  answer: string;
}

export interface GradeSuggestion {
  rating: Grade;
  reason: string;
}

export const GRADE_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "integer", enum: [1, 2, 3, 4] },
    reason: { type: "string" },
  },
  required: ["rating", "reason"],
  additionalProperties: false,
} as const;

const GRADE_SYSTEM_PROMPT = `You grade one spaced-repetition flashcard answer for a software developer.

You get the card's front (the question), its back (the reference answer) and the developer's typed answer. Card text is simple HTML; read it as the text it renders to.

Rate the unaided answer against the back, with this fixed rubric:
1 Again: wrong, or misses the concept.
2 Hard: mostly correct, but with significant gaps.
3 Good: correct, with reasonable detail.
4 Easy: complete and precise, nothing missing.

Judge substance, not wording. A terse answer that names the right idea is Good. Do not reward padding, and do not penalise typos or informal phrasing. When the developer says they don't know, rate Again.

The reason is one or two plain sentences addressed to the developer as "you". Say what was right and, on a weak answer, name the missing piece plainly: seeing the gap at once is the point. Do not ask a question back, and do not add a lecture.`;

export function buildGradePrompt(input: GradeInput): string {
  return [
    "<front>",
    input.front,
    "</front>",
    "<back>",
    input.back,
    "</back>",
    "<developer_answer>",
    input.answer,
    "</developer_answer>",
  ].join("\n");
}


/**
 * The request for one grade. The system prompt carries a cache breakpoint: it
 * is the same on every grade, and under the model's minimum cacheable length
 * the API just ignores it. max_tokens leaves room for thinking, which counts
 * toward it.
 */
export function gradeRequest(input: GradeInput, model: string = GRADE_MODEL): Anthropic.Messages.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 2048,
    system: [{ type: "text", text: GRADE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildGradePrompt(input) }],
    output_config: { effort: "low", format: { type: "json_schema", schema: GRADE_SCHEMA } },
  };
}

/** Checks the structured verdict and reshapes it. */
export function toSuggestion(out: Record<string, unknown>): GradeSuggestion {
  const rating = out.rating;
  if (!isGrade(rating)) {
    throw new Error(`grader returned an invalid rating: ${String(rating)}`);
  }
  const reason = typeof out.reason === "string" ? out.reason.trim() : "";
  if (reason === "") throw new Error("grader returned no reason");
  return { rating, reason };
}

/**
 * Reads the API's reply: the stop reason first (a declined or cut-off reply
 * has no whole verdict), then the JSON in its text block.
 */
export function parseGradeMessage(msg: Anthropic.Messages.Message): GradeSuggestion {
  if (msg.stop_reason === "refusal") {
    const category = msg.stop_details?.category;
    throw new Error(`grader declined this card${category != null ? ` (${category})` : ""}`);
  }
  if (msg.stop_reason === "max_tokens") throw new Error("grader's reply was cut off");
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let out: unknown;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error("grader returned no JSON");
  }
  if (out == null || typeof out !== "object" || Array.isArray(out)) throw new Error("grader returned no JSON");
  return toSuggestion(out as Record<string, unknown>);
}

/** Sends one grade request. Injected in tests. */
export type GradeCall = (
  body: Anthropic.Messages.MessageCreateParamsNonStreaming,
  signal: AbortSignal
) => Promise<Anthropic.Messages.Message>;

let client: Anthropic | null = null;

/**
 * The real call. The client is made on the first grade, so a deck server with
 * no key starts and serves everything else, and the grade says what is missing.
 */
export const callApi: GradeCall = async (body, signal) => {
  if ((process.env.ANTHROPIC_API_KEY ?? "") === "") {
    throw new Error("no API key: the deck server needs ANTHROPIC_API_KEY to grade");
  }
  client ??= new Anthropic({ timeout: GRADE_TIMEOUT_MS, maxRetries: GRADE_RETRIES });
  return client.messages.create(body, { signal });
};

/** One line for the app's verdict, from what the call threw. */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return `grader timed out after ${Math.round(GRADE_TIMEOUT_MS / 1000)}s`;
  }
  if (err instanceof Anthropic.APIConnectionError) return "grader could not reach the Claude API";
  if (err instanceof Anthropic.AuthenticationError) return "grader's API key was refused";
  if (err instanceof Anthropic.RateLimitError) return "grader is rate limited: try again in a moment";
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: unknown } } | undefined;
    const message = typeof body?.error?.message === "string" ? body.error.message : err.message;
    return `grader failed (${String(err.status)}): ${message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The app's grades, at most one running: a newer request aborts the grade
 * still running, since only the newest can be shown. A request claims its slot as it arrives, before the
 * handler awaits anything (the card lookup), so requests are ordered as they
 * came: an older one that gets there late finds its claim already aborted.
 * `endGrade()` ends the grade of a card that is done with.
 */
export class Grader {
  private running: AbortController | null = null;

  constructor(private readonly call: GradeCall = callApi) {}

  /** Aborts the grade still running and claims the slot for a new one. */
  claim(): AbortController {
    this.running?.abort();
    this.running = new AbortController();
    return this.running;
  }

  /** Grades `input` under a claim. */
  async grade(claim: AbortController, input: GradeInput): Promise<GradeSuggestion> {
    // A function, not the property read twice: TypeScript would keep the first
    // read's narrowing across the await, though an abort can come in between.
    const aborted = (): boolean => claim.signal.aborted;
    try {
      if (aborted()) throw new Error("grade cancelled");
      let msg: Anthropic.Messages.Message;
      try {
        msg = await this.call(gradeRequest(input), claim.signal);
        if (msg.stop_reason === "refusal") msg = await this.call(gradeRequest(input, FALLBACK_MODEL), claim.signal);
      } catch (err) {
        if (aborted() || err instanceof Anthropic.APIUserAbortError) throw new Error("grade cancelled");
        throw new Error(describeError(err));
      }
      return parseGradeMessage(msg);
    } finally {
      if (this.running === claim) this.running = null;
    }
  }

  /** The card is done with, or the session: end its grade still running. */
  endGrade(): void {
    this.running?.abort();
    this.running = null;
  }
}
