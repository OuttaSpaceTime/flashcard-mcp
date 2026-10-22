/**
 * Anki Notes in Plain Text (.txt) import/export.
 *
 * Format: tab-separated (or configurable separator) with optional
 * #header directives for the separator and the tags, guid and deck columns.
 * Fields are HTML either way (cards here are simple HTML), so `#html` is
 * written for Anki and not read back.
 *
 * Spec: https://docs.ankiweb.net/importing/text-files.html
 */

import { getDb } from "../db/client.js";
import { importCards, type ImportItem, type ImportOptions, type ImportResult } from "./card-import.js";
import { parseTags } from "./types.js";

export interface AnkiNote {
  front: string;
  back: string;
  tags?: string[];
  /** Written on export (the card id) so Anki matches a re-import; not read back. */
  guid?: string;
  deck?: string;
}

interface ParseHeaders {
  separator: string;
  tagsColumn?: number; // 1-based
  deckColumn?: number; // 1-based
  deckValue?: string; // from #deck:value
}

const SEPARATOR_MAP: Record<string, string> = {
  tab: "\t",
  semicolon: ";",
  comma: ",",
  pipe: "|",
  space: " ",
};

function parseSeparatorName(name: string): string {
  return SEPARATOR_MAP[name.toLowerCase()] ?? name;
}

function parseHeaderLines(lines: string[]): {
  headers: ParseHeaders;
  dataStartIndex: number;
} {
  const headers: ParseHeaders = { separator: "\t" };

  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) {
    const line = lines[i].trim();

    const sepMatch = line.match(/^#separator:(.+)$/);
    if (sepMatch) {
      headers.separator = parseSeparatorName(sepMatch[1].trim());
    }

    const tagsColMatch = line.match(/^#tags[\s_]?column:(\d+)$/i);
    if (tagsColMatch) {
      headers.tagsColumn = parseInt(tagsColMatch[1]);
    }

    const deckColMatch = line.match(/^#deck[\s_]?column:(\d+)$/i);
    if (deckColMatch) {
      headers.deckColumn = parseInt(deckColMatch[1]);
    }

    const deckValMatch = line.match(/^#deck:(.+)$/);
    if (deckValMatch) {
      headers.deckValue = deckValMatch[1].trim();
    }

    i++;
  }

  return { headers, dataStartIndex: i };
}

/**
 * Split a line by separator, respecting quoted fields.
 * Quoted fields can contain the separator, newlines, and escaped quotes ("").
 */
function splitRecord(line: string, separator: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i += 2;
          continue;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"' && current.length === 0) {
        inQuotes = true;
        i++;
      } else if (line.startsWith(separator, i)) {
        fields.push(current);
        current = "";
        i += separator.length;
      } else {
        current += ch;
        i++;
      }
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Join lines that are part of a quoted multi-line field.
 * Returns complete records (one per entry).
 */
function joinMultilineRecords(lines: string[]): string[] {
  const records: string[] = [];
  let current: string | null = null;

  for (const line of lines) {
    current = current === null ? line : current + "\n" + line;

    // Count unescaped quotes
    let quoteCount = 0;
    for (let i = 0; i < current.length; i++) {
      if (current[i] === '"') {
        if (i + 1 < current.length && current[i + 1] === '"') {
          i++; // skip escaped
        } else {
          quoteCount++;
        }
      }
    }

    // Even number of quotes means the record is complete
    if (quoteCount % 2 === 0) {
      records.push(current);
      current = null;
    }
  }

  if (current !== null) {
    records.push(current);
  }

  return records;
}

export function parseAnkiTxt(content: string): AnkiNote[] {
  if (content.trim() === "") return [];

  const rawLines = content.split(/\r?\n/);
  const { headers, dataStartIndex } = parseHeaderLines(rawLines);

  // Records first, so a blank line or a leading # inside a quoted field stays
  // part of it; only whole empty or comment records are dropped.
  const records = joinMultilineRecords(rawLines.slice(dataStartIndex)).filter(
    (r) => r.trim().length > 0 && !r.startsWith("#")
  );

  return records.map((record) => {
    const fields = splitRecord(record, headers.separator);

    const note: AnkiNote = {
      front: (fields[0] ?? "").trim(),
      back: (fields[1] ?? "").trim(),
    };

    const col = (n: number | undefined) =>
      n !== undefined && n <= fields.length ? fields[n - 1].trim() : undefined;

    // Tags from column
    const tagsStr = col(headers.tagsColumn);
    if (tagsStr !== undefined) {
      note.tags = tagsStr !== "" ? tagsStr.split(/\s+/) : [];
    }

    // Deck from column or header value
    const deck = col(headers.deckColumn);
    if (deck !== undefined) {
      note.deck = deck !== "" ? deck : undefined;
    } else if (headers.deckValue !== undefined) {
      note.deck = headers.deckValue;
    }

    return note;
  });
}

/**
 * Escape a field value for tab-separated output.
 * Quotes the field if it contains tabs, newlines, or double quotes.
 */
function escapeField(value: string): string {
  if (value.includes("\t") || value.includes("\n") || value.includes('"')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function exportToAnkiTxt(notes: AnkiNote[]): string {
  const lines: string[] = [];

  // Headers
  lines.push("#separator:tab");
  lines.push("#html:true");
  lines.push("#tags column:3");
  lines.push("#guid column:4");
  lines.push("#deck column:5");

  // Data
  for (const note of notes) {
    const tags = note.tags?.join(" ") ?? "";
    const guid = note.guid ?? "";
    const deck = note.deck ?? "";

    const fields = [
      escapeField(note.front),
      escapeField(note.back),
      escapeField(tags),
      escapeField(guid),
      escapeField(deck),
    ];

    lines.push(fields.join("\t"));
  }

  return lines.join("\n");
}

/**
 * Import parsed notes, each into `opts.deck` when given, else the deck its
 * file names (a deck column or `#deck:`). Throws before writing anything when
 * a note has neither.
 */
export async function importTxtNotes(
  notes: AnkiNote[],
  opts: ImportOptions & { deck?: string } = {}
): Promise<ImportResult> {
  const byDeck = new Map<string, ImportItem[]>();
  let deckless = 0;
  for (const note of notes) {
    const deck = opts.deck ?? note.deck;
    if (deck == null) {
      deckless++;
      continue;
    }
    byDeck.set(deck, [...(byDeck.get(deck) ?? []), { front: note.front, back: note.back, tags: note.tags }]);
  }
  if (deckless > 0) {
    throw new Error(`${deckless} note(s) name no deck: give one with --deck`);
  }

  return importCards(
    [...byDeck].map(([name, items]) => ({ name, items })),
    opts
  );
}

export async function exportCardsToAnkiTxt(
  deckId?: string
): Promise<{ cardCount: number; content: string }> {
  const cards = await getDb().card.findMany({
    where: deckId != null ? { deckId } : {},
    include: { deck: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });

  const content = exportToAnkiTxt(
    cards.map((c) => ({
      front: c.front,
      back: c.back,
      tags: parseTags(c.tags),
      guid: c.id,
      deck: c.deck.name,
    }))
  );

  return { cardCount: cards.length, content };
}
