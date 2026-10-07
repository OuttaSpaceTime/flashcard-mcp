import { spawn } from "node:child_process";

/**
 * Suggested ratings for typed answers, from `claude -p`.
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
 * Claude runs bare: no tools, no MCP servers, no settings or CLAUDE.md files, no
 * saved session. That keeps a grade to about three seconds, and stops the
 * grader from wandering into the wiki or the deck when the card back is all it
 * should judge against.
 */

export const GRADE_MODEL = "sonnet";
export const GRADE_TIMEOUT_MS = 60_000;

export type SuggestedRating = 1 | 2 | 3 | 4;

/** Card quality problems the grader may flag, from /study's quality check. */
export const QUALITY_ISSUES = [
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
  rating: SuggestedRating;
  reason: string;
  /** null when the card itself looked fine. */
  quality: { issue: Exclude<QualityIssue, "none">; detail: string } | null;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `claude` with argv and stdin. Injected in tests. */
export type ClaudeRunner = (argv: string[], stdin: string, timeoutMs: number) => Promise<RunResult>;

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

export const GRADE_SYSTEM_PROMPT = `You grade one spaced-repetition flashcard answer for a software developer.

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

export function gradeArgv(): string[] {
  return [
    "-p",
    "--model", GRADE_MODEL,
    "--output-format", "json",
    "--json-schema", JSON.stringify(GRADE_SCHEMA),
    "--system-prompt", GRADE_SYSTEM_PROMPT,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
  ];
}

/**
 * Reads claude's `--output-format json` envelope. The structured answer is in
 * `structured_output`; `result` carries the same object as a JSON string, used
 * as a fallback in case a CLI version leaves the first one out.
 */
export function parseGradeOutput(stdout: string): GradeSuggestion {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("grader returned no JSON");
  }
  if (envelope.is_error === true) {
    const msg = typeof envelope.result === "string" ? envelope.result : "unknown error";
    throw new Error(`grader failed: ${msg}`);
  }

  let out = envelope.structured_output as Record<string, unknown> | undefined;
  if (out == null && typeof envelope.result === "string") {
    try {
      out = JSON.parse(envelope.result) as Record<string, unknown>;
    } catch {
      out = undefined;
    }
  }
  if (out == null) throw new Error("grader returned no structured output");

  const rating = out.rating;
  if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) {
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

export const runClaude: ClaudeRunner = (argv, stdin, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", argv, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`grader timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start claude: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

export async function gradeAnswer(input: GradeInput, runner: ClaudeRunner = runClaude): Promise<GradeSuggestion> {
  if (input.answer.trim() === "") {
    throw new Error("nothing to grade: the answer is empty");
  }
  const result = await runner(gradeArgv(), buildGradePrompt(input), GRADE_TIMEOUT_MS);
  if (result.code !== 0 && result.stdout.trim() === "") {
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    throw new Error(`grader exited ${String(result.code)}${firstLine !== "" ? `: ${firstLine}` : ""}`);
  }
  return parseGradeOutput(result.stdout);
}
