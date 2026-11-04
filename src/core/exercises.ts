import { ankiClozeText, CLOZE_MARKUP, splitCloze } from "./cloze.js";
import { validateAnswer, validateCardContent, validateQuestion } from "./content-rules.js";
import { runSandboxed, type SandboxResult } from "./exercise-sandbox.js";

/**
 * Code cards: a card whose answer is checked by running it, after Execute
 * Program, which the developer has used and rates highly.
 *
 *   predict  read the code and type what `expr` evaluates to
 *   fill     complete the blanks so that every `expr` equals its `goal`
 *   compose  the same, for bigger pieces put together; on Anki, plain front and
 *            back rather than a cloze
 *
 * The checks are Execute Program's: a real interpreter evaluates the answer
 * and compares values, so `%w[a b]` answers `["a", "b"]`. A string comparison
 * was the prototype's way, and marked right answers wrong over a space or a
 * quote style; comparing values also keeps a card true across Ruby versions,
 * which print a hash differently (3.4 changed it).
 *
 * A wrong try costs nothing, and neither does an error: the rating says whether
 * the developer got there, not how many tries it took. So a pass is Good and
 * only giving up is Again (PASS_RATING, GIVE_UP_RATING). Execute Program
 * dropped its penalty for wrong tries in 2020, because a typo marked as
 * forgetting was what its users minded most. These two numbers are the whole of
 * the rule: nothing here grades by attempts, and no Claude call is made.
 *
 * `front` and `back` are written from the exercise, so everything that reads a
 * card (search, duplicates, Anki, the app's tiles) works on it unchanged, and
 * the phone reviews it as an ordinary card, rated by hand. The exercise itself
 * travels through Anki in a hidden field (the study repo's anki-sync), or a
 * card reaching another machine would arrive unable to run.
 */

export const EXERCISE_KINDS = ["predict", "fill", "compose"] as const;
export type ExerciseKind = (typeof EXERCISE_KINDS)[number];

/** The review a pass and a give-up each write (see above). */
export const PASS_RATING = 3;
export const GIVE_UP_RATING = 1;

export interface ExerciseCase {
  /** Evaluated after the source. */
  expr: string;
  /** What it must equal, as an expression; a predict card's answer. */
  goal: string;
}

export interface Exercise {
  kind: ExerciseKind;
  lang: "ruby";
  /** What to solve: one or two sentences, simple HTML. */
  brief: string;
  /** The code. fill and compose mark their blanks `{{c1::solution}}`. */
  source: string;
  cases: ExerciseCase[];
  /** The one-clause why, shown once it is over. Simple HTML. */
  explain: string;
}

/** A code card as the app draws it, with nothing that gives the answer away. */
export interface ExerciseView {
  kind: ExerciseKind;
  lang: string;
  brief: string;
  /** The source: runs of code, and between them the blanks to type in. */
  parts: Array<{ text: string } | { blank: number; multiline: boolean }>;
  /** A predict card's goals are what it asks, so they stay null. */
  cases: Array<{ expr: string; goal: string | null }>;
  /** How many answers `runExercise` takes. */
  answers: number;
}

export type ExerciseStatus = "pass" | "wrong" | "error" | "timeout" | "unavailable" | "incomplete";

export interface ExerciseCaseResult {
  expr: string;
  pass: boolean;
  /** What `expr` evaluated to, as Ruby prints it. */
  actual: string | null;
  goal: string | null;
  /** What raised while evaluating this case. */
  error: string | null;
}

export interface ExerciseResult {
  status: ExerciseStatus;
  cases: ExerciseCaseResult[];
  /** What the code printed. */
  output: string;
  /** Warnings and whatever else went to stderr. They never fail a card. */
  stderr: string;
  /** What stopped the code from running at all. */
  error: string | null;
  durationMs: number;
  /** The review this result writes, or null when the card stays up. */
  rating: number | null;
  /** The card's why, once a pass has earned it. */
  explain: string | null;
}

export interface ExerciseReveal {
  result: ExerciseResult;
  explain: string;
  /** The blanks' solutions, in order; for predict, the goals. */
  answers: string[];
  rating: number;
}

// ---- reading and checking the format ------------------------------------------

/** The exercise in a card's column, or null for an ordinary card. */
export function parseExercise(json: string | null | undefined): Exercise | null {
  if (json == null || json === "") return null;
  return JSON.parse(json) as Exercise;
}

function blanksOf(source: string): string[] {
  return splitCloze(source).flatMap((p) => ("hidden" in p ? [p.hidden] : []));
}

/** What's wrong with an exercise beyond its types (the MCP schema holds those). */
export function validateExercise(ex: Exercise): string[] {
  const problems: string[] = [];
  if (ex.cases.length === 0) problems.push("at least one case is needed");
  let blanks: string[] = [];
  try {
    blanks = blanksOf(ex.source);
    // A blank's own c1 is the format. Any other cloze would be a card of its own
    // on Anki, which the sync keeps no schedule for.
    if (splitCloze(ex.source).some((p) => CLOZE_MARKUP.test("hidden" in p ? p.hidden : p.text))) {
      problems.push("source: a blank is {{c1::solution}}, not nested and no other number");
    }
    // runExercise calls a blank answer incomplete, so this one could never pass.
    if (blanks.some((b) => b.trim() === "")) problems.push("source: a blank has no solution in it");
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (ex.cases.some((c) => CLOZE_MARKUP.test(c.expr) || CLOZE_MARKUP.test(c.goal))) {
    problems.push("cases: no cloze markup in an expr or a goal");
  }
  if (ex.kind === "predict" && blanks.length > 0) problems.push("a predict card has no blanks: it asks for each case's goal");
  if (ex.kind !== "predict" && blanks.length === 0) problems.push(`a ${ex.kind} card needs at least one {{c1::blank}} in its source`);
  for (const v of [...validateCardContent(ex.brief), ...validateQuestion(ex.brief)]) problems.push(`brief: ${v}`);
  for (const v of [...validateCardContent(ex.explain), ...validateAnswer(ex.explain)]) problems.push(`explain: ${v}`);
  return problems;
}

// ---- the card's two sides ------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function codeBlock(code: string): string {
  return `<pre><code>${code}</code></pre>`;
}

/** The source as HTML, each blank written by `blank`. */
function sourceHtml(source: string, blank: (html: string) => string): string {
  // A block's solution ends its last line: blanked, the code after it keeps its own.
  return splitCloze(source)
    .map((p) => ("hidden" in p ? blank(escapeHtml(p.hidden)) : escapeHtml(p.text)))
    .join("");
}

function caseLines(cases: ExerciseCase[], goal: (html: string) => string): string {
  return cases.map((c) => `${escapeHtml(c.expr)}\n# =&gt; ${goal(escapeHtml(c.goal))}`).join("\n");
}

/**
 * The front and back an exercise reads as, on Anki and everywhere else that
 * shows a card. All of a card's blanks are one deletion's number: cloze.ts says why.
 */
export function exerciseSides(ex: Exercise): { front: string; back: string } {
  const cloze = (html: string): string => `{{c1::${ankiClozeText(html)}}}`;
  const shown = (html: string): string => html;
  const blanked = (html: string): string => (html.endsWith("\n") ? "___\n" : "___");
  const source = ex.source === "" ? "" : `${sourceHtml(ex.source, ex.kind === "fill" ? cloze : blanked)}\n`;
  const goals = caseLines(ex.cases, ex.kind === "predict" ? cloze : shown);
  // No <br> before the block: a <pre> starts its own line, and the simple-HTML
  // form the sync checks for (the study repo's htmlize.py) has none there.
  const front = `${ex.brief}${codeBlock(source + goals)}`;
  if (ex.kind !== "compose") return { front, back: ex.explain };
  return { front, back: `${codeBlock(sourceHtml(ex.source, shown))}${ex.explain}` };
}

/** What the app gets to draw. Never the solutions: those come with giving up. */
export function exerciseView(ex: Exercise): ExerciseView {
  let blank = 0;
  const parts: ExerciseView["parts"] = splitCloze(ex.source).map((p) =>
    "hidden" in p ? { blank: blank++, multiline: p.hidden.includes("\n") } : { text: p.text }
  );
  const predict = ex.kind === "predict";
  return {
    kind: ex.kind,
    lang: ex.lang,
    brief: ex.brief,
    parts,
    cases: ex.cases.map((c) => ({ expr: c.expr, goal: predict ? null : c.goal })),
    answers: predict ? ex.cases.length : blank,
  };
}

// ---- running ----------------------------------------------------------------------

/**
 * The source with these answers in its blanks. A block's solution ends its last
 * line, so the code after it starts right at the blank's end, with no newline of
 * its own. An answer that doesn't end its last line gets one, or a body typed as
 * `new_list` ran into the method's `end` and was a syntax error about
 * `new_listend`, which nobody had typed.
 */
function filled(source: string, answers: string[]): string {
  let i = 0;
  return splitCloze(source)
    .map((p) => {
      if (!("hidden" in p)) return p.text;
      const answer = answers[i++] ?? "";
      return p.hidden.endsWith("\n") && !answer.endsWith("\n") ? `${answer}\n` : answer;
    })
    .join("");
}

function fromSandbox(run: SandboxResult, cases: ExerciseCaseResult[], error: string | null): ExerciseResult {
  const failed = error != null || cases.some((c) => c.error != null);
  const status: ExerciseStatus =
    run.status !== "ran" ? run.status : failed ? "error" : cases.every((c) => c.pass) ? "pass" : "wrong";
  return {
    status,
    cases,
    output: run.stdout,
    stderr: run.stderr,
    error,
    durationMs: run.durationMs,
    rating: status === "pass" ? PASS_RATING : null,
    explain: null,
  };
}

async function runCases(source: string, cases: ExerciseCase[], signal?: AbortSignal): Promise<ExerciseResult> {
  const run = await runSandboxed({ source, cases }, signal);
  const reported = run.report;
  const results: ExerciseCaseResult[] = (reported?.cases ?? []).map((c, i) => ({
    expr: cases[i].expr,
    pass: c.pass,
    actual: c.actual,
    goal: c.goal,
    error: c.error,
  }));
  return fromSandbox(run, results, reported?.error ?? run.failure);
}

/** A prediction's outcome says nothing of the real value until it is right. */
function hideUnlessPassed(result: ExerciseResult): ExerciseResult {
  if (result.status === "pass") return result;
  return {
    ...result,
    output: "",
    stderr: "",
    cases: result.cases.map((c) => ({ ...c, actual: null })),
  };
}

const emptyResult = (status: ExerciseStatus): ExerciseResult => ({
  status,
  cases: [],
  output: "",
  stderr: "",
  error: null,
  durationMs: 0,
  rating: null,
  explain: null,
});

/** One try at a card. Refuses nothing: a wrong answer is an answer. `signal` stops a run nobody waits for. */
export async function runExercise(ex: Exercise, answers: string[], signal?: AbortSignal): Promise<ExerciseResult> {
  const view = exerciseView(ex);
  const given = Array.from({ length: view.answers }, (_, i) => answers[i] ?? "");
  if (given.some((a) => a.trim() === "")) return emptyResult("incomplete");
  const result =
    ex.kind === "predict"
      ? hideUnlessPassed(await runCases(ex.source, ex.cases.map((c, i) => ({ expr: c.expr, goal: given[i] })), signal))
      : await runCases(filled(ex.source, given), ex.cases, signal);
  return result.status === "pass" ? { ...result, explain: ex.explain } : result;
}

/** The solution, run, for a card given up on. */
export async function revealExercise(ex: Exercise): Promise<ExerciseReveal> {
  const answers = ex.kind === "predict" ? ex.cases.map((c) => c.goal) : blanksOf(ex.source);
  const result = await runCases(filled(ex.source, answers), ex.cases);
  return { result: { ...result, rating: null }, explain: ex.explain, answers, rating: GIVE_UP_RATING };
}

/** What a dry run of an exercise found (check_code_card; every write runs it too). */
export interface ExerciseCheck {
  ok: boolean;
  /** Why it can't be saved. Empty when ok. */
  problems: string[];
  /** The solution, run: what each case really gives, whether it passes or not. */
  solution: ExerciseResult | null;
  /** The two sides it would be saved with, as Anki and every list will show them. */
  sides: { front: string; back: string } | null;
}

function failingCase(result: ExerciseResult): string {
  const failing = result.cases.find((c) => !c.pass);
  return (
    result.error ??
    (failing == null ? result.status : (failing.error ?? `${failing.expr} is ${failing.actual}, not ${failing.goal}`))
  );
}

/**
 * Whether a card can be saved, for real. Its solution has to pass, or it could
 * never be answered; a hand-written goal is how a card comes to teach something
 * false. With its blanks nil it has to fail, or it asks nothing. And two runs
 * have to agree, or a card that depends on the time or on randomness fails its
 * reviewer some days for nothing. What the rubric can't run is the gate's
 * (the study repo's card-quality.md).
 */
export async function checkExercise(ex: Exercise): Promise<ExerciseCheck> {
  const problems = validateExercise(ex);
  if (problems.length > 0) return { ok: false, problems, solution: null, sides: null };
  const sides = exerciseSides(ex);
  const { result } = await revealExercise(ex);
  if (result.status === "unavailable") problems.push(result.error ?? "the runner is unavailable");
  else if (result.status !== "pass") problems.push(`its own solution does not pass (${failingCase(result)})`);
  else {
    const again = await revealExercise(ex);
    // Without object addresses: a default inspect prints a new one on every run,
    // which says nothing of whether the card is stable.
    const values = (r: ExerciseResult): string =>
      JSON.stringify([r.cases.map((c) => c.actual), r.output]).replace(/0x[0-9a-f]+/g, "0x");
    if (values(again.result) !== values(result)) {
      problems.push("two runs of it differ: it depends on the time, on randomness or on something else that changes");
    }
    if (ex.kind !== "predict") {
      const empty = await runCases(filled(ex.source, blanksOf(ex.source).map(() => "nil")), ex.cases);
      if (empty.status === "pass") problems.push("it passes with every blank nil, so it asks nothing");
    }
  }
  return { ok: problems.length === 0, problems, solution: result, sides };
}

/** Refuses an exercise a dry run finds fault with. */
export async function assertExerciseWorks(ex: Exercise): Promise<void> {
  const { problems } = await checkExercise(ex);
  if (problems.length > 0) throw new Error(`code card not saved: ${problems.join("; ")}`);
}
