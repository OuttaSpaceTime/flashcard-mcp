/**
 * Anki Notes in Plain Text (.txt) import/export.
 *
 * Format: tab-separated (or configurable separator) with optional
 * #header directives for metadata, tags, guid, deck, notetype.
 *
 * Spec: https://docs.ankiweb.net/importing/text-files.html
 */

export interface AnkiNote {
  front: string;
  back: string;
  tags?: string[];
  guid?: string;
  deck?: string;
  notetype?: string;
}

interface ParseHeaders {
  separator: string;
  html: boolean;
  tagsColumn?: number; // 1-based
  guidColumn?: number; // 1-based
  deckColumn?: number; // 1-based
  notetypeColumn?: number; // 1-based
  deckValue?: string; // from #deck:value
  notetypeValue?: string; // from #notetype:value
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
  const headers: ParseHeaders = {
    separator: "\t",
    html: false,
  };

  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) {
    const line = lines[i].trim();

    const sepMatch = line.match(/^#separator:(.+)$/);
    if (sepMatch) {
      headers.separator = parseSeparatorName(sepMatch[1].trim());
    }

    const htmlMatch = line.match(/^#html:(true|false)$/i);
    if (htmlMatch) {
      headers.html = htmlMatch[1].toLowerCase() === "true";
    }

    const tagsColMatch = line.match(/^#tags[\s_]?column:(\d+)$/i);
    if (tagsColMatch) {
      headers.tagsColumn = parseInt(tagsColMatch[1]);
    }

    const guidColMatch = line.match(/^#guid[\s_]?column:(\d+)$/i);
    if (guidColMatch) {
      headers.guidColumn = parseInt(guidColMatch[1]);
    }

    const deckColMatch = line.match(/^#deck[\s_]?column:(\d+)$/i);
    if (deckColMatch) {
      headers.deckColumn = parseInt(deckColMatch[1]);
    }

    const notetypeColMatch = line.match(/^#notetype[\s_]?column:(\d+)$/i);
    if (notetypeColMatch) {
      headers.notetypeColumn = parseInt(notetypeColMatch[1]);
    }

    const deckValMatch = line.match(/^#deck:(.+)$/);
    if (deckValMatch && !line.match(/^#deck[\s_]?column:/i)) {
      headers.deckValue = deckValMatch[1].trim();
    }

    const notetypeValMatch = line.match(/^#notetype:(.+)$/);
    if (notetypeValMatch && !line.match(/^#notetype[\s_]?column:/i)) {
      headers.notetypeValue = notetypeValMatch[1].trim();
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
  let current = "";

  for (const line of lines) {
    if (current.length > 0) {
      current += "\n" + line;
    } else {
      current = line;
    }

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
      current = "";
    }
  }

  if (current.length > 0) {
    records.push(current);
  }

  return records;
}

export function parseAnkiTxt(content: string): AnkiNote[] {
  if (content.trim() === "") return [];

  const rawLines = content.split("\n");
  const { headers, dataStartIndex } = parseHeaderLines(rawLines);

  // Filter data lines (skip empty, skip # comments after headers)
  const dataLines = rawLines
    .slice(dataStartIndex)
    .filter((l) => l.trim().length > 0 && !l.startsWith("#"));

  if (dataLines.length === 0) return [];

  // Join multi-line records
  const records = joinMultilineRecords(dataLines);

  return records.map((record) => {
    const fields = splitRecord(record, headers.separator);

    const note: AnkiNote = {
      front: fields[0] ?? "",
      back: fields[1] ?? "",
    };

    const col = (n: number | undefined) =>
      n !== undefined && n <= fields.length ? fields[n - 1].trim() : undefined;

    // Tags from column
    const tagsStr = col(headers.tagsColumn);
    if (tagsStr !== undefined) {
      note.tags = tagsStr !== "" ? tagsStr.split(/\s+/) : [];
    }

    // GUID from column
    const guid = col(headers.guidColumn);
    if (guid !== undefined) {
      note.guid = guid !== "" ? guid : undefined;
    }

    // Deck from column or header value
    const deck = col(headers.deckColumn);
    if (deck !== undefined) {
      note.deck = deck !== "" ? deck : undefined;
    } else if (headers.deckValue !== undefined) {
      note.deck = headers.deckValue;
    }

    // Notetype from column or header value
    const notetype = col(headers.notetypeColumn);
    if (notetype !== undefined) {
      note.notetype = notetype !== "" ? notetype : undefined;
    } else if (headers.notetypeValue !== undefined) {
      note.notetype = headers.notetypeValue;
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

// --- Shared import/export service functions ---

import { getDb } from "../db/client.js";
import { createCard } from "./card-service.js";
import { parseTags, serializeTags } from "./types.js";

export async function importTxtNotes(
  notes: AnkiNote[],
  deckId: string,
  opts: { dryRun?: boolean; conflict?: "ours" | "theirs" } = {}
): Promise<{ created: number; updated: number; duplicates: number; skipped: number }> {
  const { dryRun = false, conflict = "ours" } = opts;
  const db = getDb();
  let created = 0;
  let updated = 0;
  let duplicates = 0;
  let skipped = 0;

  for (const note of notes) {
    if (note.front.trim() === "") {
      skipped++;
      continue;
    }

    const existing = await db.card.findFirst({
      where: { deckId, front: note.front },
    });

    if (existing) {
      if (conflict === "theirs") {
        updated++;
        if (!dryRun) {
          await db.card.update({
            where: { id: existing.id },
            data: {
              back: note.back,
              tags: serializeTags(note.tags),
            },
          });
        }
      } else {
        duplicates++;
      }
      continue;
    }

    if (!dryRun) {
      await createCard({
        deckId,
        front: note.front,
        back: note.back,
        tags: note.tags,
      });
    }
    created++;
  }

  return { created, updated, duplicates, skipped };
}

export async function exportCardsToAnkiTxt(
  deckId?: string
): Promise<{ cardCount: number; content: string }> {
  const db = getDb();
  const where = deckId ? { deckId } : {};

  const cards = await db.card.findMany({
    where,
    include: { deck: { select: { name: true } } },
    orderBy: { createdAt: "asc" as const },
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
