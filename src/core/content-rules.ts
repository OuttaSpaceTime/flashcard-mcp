/**
 * Card content rules: fields are simple HTML, the only format Anki renders
 * reliably (<b>, <i>, <code>, <pre>, <ul>/<ol>/<li>, <br>).
 *
 * Markdown is rejected because Anki shows it literally. Em dashes are
 * rejected as a style rule: write two sentences instead. Enforced at write
 * time so cards are born clean (the study repo's scripts/card-htmlize can
 * convert legacy content).
 *
 * Answers are additionally capped by size and by sentence count, and fronts
 * must ask a single question. Both limits measure rendered text, not markup,
 * so formatting a card well never costs it budget.
 */

export const MAX_ANSWER_CHARS = 200;
export const MAX_ANSWER_SENTENCES = 4;

interface Rule {
  pattern: RegExp;
  message: string;
}

const RULES: Rule[] = [
  {
    pattern: /—|&mdash;|&#8212;|&#x2014;/i,
    message: "em dash (—) is forbidden, write two sentences instead (the &mdash; entity counts, Anki renders it identically)",
  },
  {
    pattern: /`/,
    message: "markdown backticks are not supported, use <code>...</code> (or <pre><code>...</code></pre> for blocks)",
  },
  {
    pattern: /\*\*[^*\n]+\*\*/,
    message: "markdown bold is not supported, use <b>...</b>",
  },
  {
    pattern: /\[\[[^\]]+\]\]/,
    message: "wikilinks are not supported in card content, card text must stand alone",
  },
  {
    pattern: /(?:^|<br\s*\/?>)\s*[-*] /m,
    message: "markdown list lines are not supported, use <ul><li>...</li></ul>",
  },
  {
    pattern: /(?:^|<br\s*\/?>)\s*\d+\. /m,
    message: "markdown numbered lists are not supported, use <ol><li>...</li></ol>",
  },
];

/** Returns human-readable violations; empty array = content is clean. */
export function validateCardContent(text: string): string[] {
  const violations: string[] = [];
  // newlines are only legitimate inside <pre> blocks
  const outsidePre = text.replace(/<pre>[\s\S]*?<\/pre>/g, "");
  if (outsidePre.includes("\n")) {
    violations.push("bare newlines are not supported, use <br> (newlines only render inside <pre>)");
  }
  for (const rule of RULES) {
    if (rule.pattern.test(outsidePre)) {
      violations.push(rule.message);
    }
  }
  return violations;
}

/** The text a reviewer actually reads: markup stripped, entities resolved. */
export function visibleText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(li|p|div|pre|ul|ol|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Code spans carry punctuation that is not prose (nil?, 3.14, i.e.). */
function neutralizeCode(html: string): string {
  return html
    .replace(/<pre>[\s\S]*?<\/pre>/gi, " CODE ")
    .replace(/<code>[\s\S]*?<\/code>/gi, " CODE ");
}

const ABBREVIATION = /\b(?:e\.g|i\.e|vs|etc|cf|approx|no|al|inc|ltd|dr|mr|ms|st|jr|sr)\.$/i;

/** Sentence-ish units: terminal punctuation, plus each list item and line break. */
export function countSentences(html: string): number {
  const withBreaks = neutralizeCode(html)
    .replace(/<br\s*\/?>/gi, ". ")
    .replace(/<\/(li|p|div|h[1-6])>/gi, ". ")
    .replace(/<(ul|ol)>/gi, ". ");
  const text = visibleText(withBreaks);

  const chunks = text.split(/(?<=[.!?])\s+/);
  const units: string[] = [];
  for (const chunk of chunks) {
    if (!/[a-zA-Z0-9]/.test(chunk)) continue;
    if (units.length > 0 && ABBREVIATION.test(units[units.length - 1])) {
      units[units.length - 1] += ` ${chunk}`;
      continue;
    }
    units.push(chunk);
  }
  return units.length;
}

/** Size and shape limits for the answer side. */
export function validateAnswer(html: string): string[] {
  const violations: string[] = [];
  const length = visibleText(html).length;
  if (length > MAX_ANSWER_CHARS) {
    violations.push(
      `${length} visible characters exceeds the ${MAX_ANSWER_CHARS} character limit. ` +
        `Either split the card into several cards, one per idea, or reduce the text. ` +
        `Markup does not count, so only the words a reviewer reads can be trimmed.`
    );
  }
  const sentences = countSentences(html);
  if (sentences > MAX_ANSWER_SENTENCES) {
    violations.push(
      `${sentences} sentences exceeds the ${MAX_ANSWER_SENTENCES} sentence limit. ` +
        `Either split the card into several cards, one per idea, or reduce the text.`
    );
  }
  return violations;
}

const SECOND_INTERROGATIVE = /\b(?:and|or)\s+(?:what|why|how|when|which|where|who)\b/i;

/** One card asks one question. Heuristic only: it flags, the caller judges. */
export function validateQuestion(html: string): string[] {
  const text = visibleText(neutralizeCode(html));
  const marks = (text.match(/\?/g) ?? []).length;
  const conjoined = SECOND_INTERROGATIVE.exec(text);

  if (marks < 2 && conjoined === null) return [];

  const evidence = conjoined !== null ? `"${conjoined[0]}"` : `${marks} question marks`;
  return [
    `asks more than one question (${evidence}). ` +
      `Split into one card per question, or drop the extra question.`,
  ];
}

/** Throws a clean per-field error when any provided field violates the rules. */
export function assertCardContent(fields: { front?: string; back?: string }): void {
  const problems: string[] = [];
  const { front, back } = fields;
  if (front !== undefined) {
    for (const violation of [...validateCardContent(front), ...validateQuestion(front)]) {
      problems.push(`front: ${violation}`);
    }
  }
  if (back !== undefined) {
    for (const violation of [...validateCardContent(back), ...validateAnswer(back)]) {
      problems.push(`back: ${violation}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Card content rejected (cards are simple HTML, see "Card Content Format"):\n- ${problems.join("\n- ")}`
    );
  }
}
