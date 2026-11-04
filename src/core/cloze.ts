/**
 * Cloze deletions, as Anki writes them: `{{c1::hidden}}`. Only code cards have
 * them (exercises.ts writes them); content-rules.ts refuses one anywhere else.
 *
 * Every deletion in a card is c1, on purpose. Anki makes one card per cloze
 * number, and anki-sync keeps one schedule per note, so c2 would be a card
 * nothing here tracks. All of a card's blanks are hidden together instead, and
 * one rating answers for them.
 *
 * Two readings, as there are two writers. An exercise's source is written by
 * hand, and its blanks are often code, so the closing `}}` is found by counting
 * braces: `{{c1::{ a: { b: 1 }}}}`. A card's front is what Anki stores and reads,
 * where the first `}}` closes it, whatever came before; ankiClozeText makes sure
 * that is the right one. Counting there as well would misread it: the closing
 * braces inside are character references, and no longer balance the open ones.
 */

const OPEN = "{{c1::";

/** Any cloze number, escaped or not by the writer's intent: Anki reads them all. */
export const CLOZE_MARKUP = /\{\{c\d+::/;

export type ClozePart = { text: string } | { hidden: string };

/** Where a deletion's `}}` starts, by Anki's rule. */
function firstBraces(text: string, from: number): number {
  return text.indexOf("}}", from);
}

/** A hand-written source split into its plain runs and its blanks, in order. */
export function splitCloze(text: string): ClozePart[] {
  return split(text, closingBraces);
}

function split(text: string, closing: (text: string, from: number) => number): ClozePart[] {
  const parts: ClozePart[] = [];
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf(OPEN, at);
    if (start === -1) break;
    const inner = start + OPEN.length;
    const end = closing(text, inner);
    if (end === -1) throw new Error("a cloze deletion ({{c1::) is never closed, or holds a } with no { before it");
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ hidden: text.slice(inner, end) });
    at = end + 2;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Where the `}}` that closes a deletion starts, or -1. */
function closingBraces(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      if (depth === 0) return text[i + 1] === "}" ? i : -1;
      depth--;
    }
  }
  return -1;
}

export function hasCloze(text: string): boolean {
  return text.includes(OPEN);
}

/**
 * A deletion's text as Anki must store it: `}}` would close it early, as would
 * a last `}` running into the closing pair, and `::` would start its hint. All of
 * them are ordinary code (`{ a: { b: 1 }}`, `{ |x| x }`, `Foo::Bar`). As
 * character references they render the same and Anki's cloze parser passes over them.
 */
export function ankiClozeText(html: string): string {
  return html.replace(/}(?=}|$)/g, "&#125;").replace(/::/g, "&#58;&#58;");
}

/** What the two sides of a card read as: the deletions hidden, then shown. */
export function clozeSides(front: string, back: string): { front: string; back: string } {
  if (!hasCloze(front)) return { front, back };
  const parts = split(front, firstBraces);
  const hidden = parts.map((p) => ("hidden" in p ? "[...]" : p.text)).join("");
  const shown = parts.map((p) => ("hidden" in p ? `<b>${p.hidden}</b>` : p.text)).join("");
  return { front: hidden, back: back === "" ? shown : `${shown}<br>${back}` };
}

