/**
 * Card content rules: fields are simple HTML, the only format Anki renders
 * reliably (<b>, <i>, <code>, <pre>, <ul>/<ol>/<li>, <br>).
 *
 * Markdown is rejected because Anki shows it literally. Em dashes are
 * rejected as a style rule: write two sentences instead. Enforced at write
 * time so cards are born clean (the study repo's scripts/card-htmlize can
 * convert legacy content).
 */

interface Rule {
  pattern: RegExp;
  message: string;
}

const RULES: Rule[] = [
  {
    pattern: /—/,
    message: "em dash (—) is forbidden, write two sentences instead",
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

/** Throws a clean per-field error when any provided field violates the rules. */
export function assertCardContent(fields: Record<string, string | undefined>): void {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    for (const violation of validateCardContent(value)) {
      problems.push(`${name}: ${violation}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Card content rejected (cards are simple HTML, see "Card Content Format"):\n- ${problems.join("\n- ")}`
    );
  }
}
