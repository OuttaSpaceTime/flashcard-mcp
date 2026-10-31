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
 * judges against, the verdict a structured output against GRADE_SCHEMA. Sonnet
 * as before, with thinking off (`between_tools` is Sonnet 5.5's lowest setting)
 * and effort low: the rubric is the judgement, and the reply is two sentences.
 * Server-side fallback is on, so a security card the cyber classifier declines
 * is graded by the fallback model instead of failing.
 *
 * It ran on `claude -p` first, and was moved off it (2026-10-30) because a
 * grade took about three seconds there: a second of the CLI starting (hidden
 * behind a spare process booted ahead), and a second turn the CLI spends on
 * `--json-schema`. The API answers in one round trip, 1.5-2.5s (measured on
 * the fixture deck, 2026-10-30). The cost is that grades
 * bill an API key rather than the Claude subscription, about $0.003 each; the
 * key comes from the environment (ANTHROPIC_API_KEY), which Omvida's deck
 * script fills from the login keyring.
 *
 * The app grades once per card, on the reveal (it graded on every pause in
 * the typing while grades were free). The `Grader` still runs at most one,
 * aborting a grade the next card or a newer request makes moot, so nothing
 * is billed for a verdict nobody will see. Each grade is a fresh request,
 * never a turn added to the last one: an earlier draft and its verdict must
 * not sway the rating.
 */

const GRADE_MODEL = "claude-sonnet-5-5";
// One attempt's deadline, and one retry (on a 429, a 5xx or a dropped
// connection): a grade gives up within a minute, under the app's request
// timeout (Omvida's Config.requestTimeout).
const GRADE_TIMEOUT_MS = 25_000;
const GRADE_RETRIES = 1;

/** Card quality problems the grader may flag, from /study's quality check. */
const QUALITY_ISSUES = [
  "none",
  "too_vague",
  "too_broad",
  "outdated",
  "ambiguous_front",
  "opinion_bait",
  "mismatched",
  "cloze",
  "verbose_answer",
  "two_questions",
] as const;
export type QualityIssue = (typeof QUALITY_ISSUES)[number];

export interface GradeInput {
  front: string;
  back: string;
  answer: string;
}

export interface GradeSuggestion {
  rating: Grade;
  reason: string;
  /** null when the card itself looked fine. */
  quality: { issue: Exclude<QualityIssue, "none">; detail: string } | null;
}

export const GRADE_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "integer", enum: [1, 2, 3, 4] },
    reason: { type: "string" },
    quality_issue: { type: "string", enum: [...QUALITY_ISSUES] },
    quality_detail: { type: "string" },
  },
  required: ["rating", "reason", "quality_issue"],
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

The reason is one or two plain sentences addressed to the developer as "you". Say what was right and, on a weak answer, name the missing piece plainly: seeing the gap at once is the point. Do not ask a question back, and do not add a lecture.

Also check the card itself. Set quality_issue to "none" unless the card has a real problem: too_vague (the back is too thin to learn from), too_broad (the front covers several concepts), outdated (deprecated API or pattern), ambiguous_front (unclear without the back), opinion_bait (asks for a "best" or "single most" with no single answer), mismatched (asks what, answers why, or the reverse), cloze (contains {{c1::...}}), verbose_answer (the back pads with a restated question or a second idea), two_questions (the front asks two things). Do not flag a card for being short when its back is precise. When you flag one, quality_detail says what is wrong in one sentence.`;

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
 * the API just ignores it.
 */
export function gradeRequest(input: GradeInput): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model: GRADE_MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: GRADE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildGradePrompt(input) }],
    thinking: { type: "between_tools" },
    output_config: { effort: "low", format: { type: "json_schema", schema: GRADE_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
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

  const issue = out.quality_issue;
  const detail = typeof out.quality_detail === "string" ? out.quality_detail.trim() : "";
  const quality =
    typeof issue === "string" && issue !== "none" && (QUALITY_ISSUES as readonly string[]).includes(issue)
      ? { issue: issue as Exclude<QualityIssue, "none">, detail }
      : null;

  return { rating, reason, quality };
}

/**
 * Reads the API's reply: the stop reason first (a declined or cut-off reply
 * has no whole verdict), then the JSON in its text block.
 */
export function parseGradeMessage(msg: Anthropic.Beta.Messages.BetaMessage): GradeSuggestion {
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
  body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  signal: AbortSignal
) => Promise<Anthropic.Beta.Messages.BetaMessage>;

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
  return client.beta.messages.create(body, { signal });
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
      let msg: Anthropic.Beta.Messages.BetaMessage;
      try {
        msg = await this.call(gradeRequest(input), claim.signal);
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
