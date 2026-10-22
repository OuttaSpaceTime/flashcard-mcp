import { spawn } from "node:child_process";
import type { Grade } from "ts-fsrs";
import { isGrade } from "./scheduler.js";

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
 *
 * About a second of those three is `claude` starting up, so the `Grader` keeps
 * one booted ahead (a spare) for as long as a session is open, and the app
 * grades while the developer pauses typing, so a grade is often done by the
 * time they reveal. The spare holds nothing of a card (the prompt is all
 * there is of one), so it lives from card to card: ending it with each card
 * would only boot an identical one, a second of CPU per card.
 * Each grade still gets a fresh process: sending a changed answer to the same
 * conversation would save nothing on the model's side (it reads it all again)
 * and would let the earlier draft and its verdict sway the rating. The spare
 * takes its prompt as a stream-json message, because a plain-text `claude -p`
 * gives up on stdin after three seconds and runs with no prompt.
 *
 * Measured and rejected (2026-10-19, 15 cards, Sonnet): `--effort low` changed
 * neither the time nor the ratings (no thinking happens at the default), and
 * asking for the JSON in the prompt instead of `--json-schema` saves the second
 * turn but was slower overall (median 5.4s against 3.7s) and moved two ratings.
 */

const GRADE_MODEL = "sonnet";
const GRADE_TIMEOUT_MS = 60_000;

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

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * A `claude` that has been started and waits for its one prompt. `send` writes
 * the prompt and closes stdin, and resolves when the process exits; `kill`
 * ends it, sent or not, and a pending `send` rejects. `exited` is true once the
 * process is gone or killed: it can take no prompt.
 */
export interface ClaudeProcess {
  send(stdin: string, timeoutMs: number): Promise<RunResult>;
  kill(): void;
  readonly exited: boolean;
}

/** Starts `claude` with argv. Injected in tests. */
export type ClaudeStarter = (argv: string[]) => ClaudeProcess;

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

export function gradeArgv(): string[] {
  return [
    "-p",
    "--model", GRADE_MODEL,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(GRADE_SCHEMA),
    "--system-prompt", GRADE_SYSTEM_PROMPT,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
  ];
}

/** The prompt as the one stream-json message the grader reads from stdin. */
export function gradeMessage(input: GradeInput): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: buildGradePrompt(input) } }) + "\n";
}

/**
 * The result envelope in claude's stream-json output: the last line of type
 * "result", after the init and message lines.
 */
function resultEnvelope(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: unknown;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (ev == null || typeof ev !== "object" || Array.isArray(ev)) continue;
    if ((ev as Record<string, unknown>).type === "result") return ev as Record<string, unknown>;
  }
  return null;
}

/**
 * Reads claude's result envelope. The structured answer is in
 * `structured_output`; `result` carries the same object as a JSON string, used
 * as a fallback in case a CLI version leaves the first one out. `noResult` is
 * the error when there is no envelope at all (how claude exited, if it failed).
 */
export function parseGradeOutput(stdout: string, noResult = "grader returned no JSON"): GradeSuggestion {
  const envelope = resultEnvelope(stdout);
  if (envelope == null) throw new Error(noResult);
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

export const startClaude = (argv: string[], command = "claude"): ClaudeProcess => {
  const child = spawn(command, argv, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let exited = false;
  let cancel: (err: Error) => void = () => {};
  // The process's one outcome, settled by whichever comes first: its exit,
  // a failure to start, or a kill. A spare killed unused has nobody waiting.
  const done = new Promise<RunResult>((resolve, reject) => {
    cancel = reject;
    child.on("error", (err) => reject(new Error(`could not start claude: ${err.message}`)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  done.catch(() => {});
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  // `exit`, not `close`: close waits for the output too, which a child of the
  // process can hold open after a kill.
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  // Writing to a process that is already gone fails with EPIPE; that must not
  // take the server down. `done` reports it instead.
  child.stdin.on("error", () => {});
  return {
    get exited() {
      return exited;
    },
    async send(stdin, timeoutMs) {
      child.stdin.end(stdin);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`grader timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([done, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    kill() {
      exited = true;
      child.kill("SIGTERM");
      cancel(new Error("grade cancelled"));
    },
  };
};

/**
 * The app's grades: at most one running, and one spare `claude` booted and
 * waiting for the next prompt while a session is open.
 *
 * The app grades while the developer types, so grades overlap: a newer answer
 * ends the grade still running, since only the newest can be shown. A request
 * claims its process as it arrives, before the handler awaits anything (the
 * card lookup), so requests are ordered as they came: an older one that gets
 * there late finds its process already killed. `endGrade()` ends the grade
 * of a card that is done with; `close()` ends the spare too.
 */
export class Grader {
  private spare: ClaudeProcess | null = null;
  private running: ClaudeProcess | null = null;

  constructor(private readonly start: ClaudeStarter = startClaude) {}

  /** Boot a claude for the next grade, if none is waiting. */
  prepare(): void {
    if (this.spare == null || this.spare.exited) this.spare = this.start(gradeArgv());
  }

  /**
   * Ends the grade still running and takes the spare (or a fresh claude when
   * there is none) for a new one; another spare boots for the next grade.
   */
  claim(): ClaudeProcess {
    this.running?.kill();
    let proc = this.spare;
    this.spare = null;
    if (proc == null || proc.exited) proc = this.start(gradeArgv());
    this.running = proc;
    this.spare = this.start(gradeArgv());
    return proc;
  }

  /** Grades `input` on a claimed process. */
  async grade(proc: ClaudeProcess, input: GradeInput): Promise<GradeSuggestion> {
    try {
      const result = await proc.send(gradeMessage(input), GRADE_TIMEOUT_MS);
      const firstLine = result.stderr.trim().split("\n")[0] ?? "";
      const exit = `grader exited ${String(result.code)}${firstLine !== "" ? `: ${firstLine}` : ""}`;
      return parseGradeOutput(result.stdout, result.code !== 0 ? exit : undefined);
    } finally {
      if (this.running === proc) this.running = null;
    }
  }

  /** The card is done with: end its grade still running. */
  endGrade(): void {
    this.running?.kill();
    this.running = null;
  }

  /** The session is over: end the grade still running and the spare. */
  close(): void {
    this.endGrade();
    this.spare?.kill();
    this.spare = null;
  }
}
