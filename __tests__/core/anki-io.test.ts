import { describe, it, expect, beforeEach } from "vitest";
import {
  exportToAnkiTxt,
  exportCardsToAnkiTxt,
  parseAnkiTxt,
  importTxtNotes,
  type AnkiNote,
} from "../../src/core/anki-io.js";
import { createDeck } from "../../src/core/deck-service.js";
import { createCard } from "../../src/core/card-service.js";
import { PAUSE_FLASHCARDS, PAUSE_NEW_TODAY } from "../../src/core/pressure.js";
import { getDb } from "../../src/db/client.js";
import { State } from "ts-fsrs";

let deckId: string;

describe("anki-io", () => {
  beforeEach(async () => {
    const deck = await createDeck("React");
    deckId = deck.id;
  });

  // --- Parsing (Import) ---

  describe("parseAnkiTxt", () => {
    it("parses basic tab-separated notes", () => {
      const txt = "What is JSX?\tA syntax extension for JS\nWhat is a hook?\tA function that lets you use state";

      const notes = parseAnkiTxt(txt);
      expect(notes.length).toBe(2);
      expect(notes[0].front).toBe("What is JSX?");
      expect(notes[0].back).toBe("A syntax extension for JS");
      expect(notes[1].front).toBe("What is a hook?");
      expect(notes[1].back).toBe("A function that lets you use state");
    });

    it("respects #separator header", () => {
      const txt = "#separator:semicolon\nWhat is JSX?;A syntax extension\nWhat is a hook?;A function";

      const notes = parseAnkiTxt(txt);
      expect(notes.length).toBe(2);
      expect(notes[0].front).toBe("What is JSX?");
      expect(notes[0].back).toBe("A syntax extension");
    });

    it("respects #separator:comma header", () => {
      const txt = "#separator:comma\nfront,back\n";

      const notes = parseAnkiTxt(txt);
      expect(notes.length).toBe(1);
      expect(notes[0].front).toBe("front");
      expect(notes[0].back).toBe("back");
    });

    it("parses tags from designated column", () => {
      const txt = "#separator:tab\n#tags column:3\nWhat is JSX?\tA syntax ext\ttag1 tag2\nWhat is a hook?\tA function\treact hooks";

      const notes = parseAnkiTxt(txt);
      expect(notes[0].tags).toEqual(["tag1", "tag2"]);
      expect(notes[1].tags).toEqual(["react", "hooks"]);
    });

    it("leaves tags undefined when the file has no tags column", () => {
      expect(parseAnkiTxt("Q1\tA1")[0].tags).toBeUndefined();
    });

    it("skips empty lines and comment lines", () => {
      const txt = "#separator:tab\n\nQ1\tA1\n\n# this is a comment\nQ2\tA2\n";

      const notes = parseAnkiTxt(txt);
      expect(notes.length).toBe(2);
    });

    it("strips CRLF line endings from every field", () => {
      const txt = "#separator:tab\r\n#tags column:3\r\nQ1\tA1\ttag1\r\nQ2\tA2\ttag2\r\n";

      const notes = parseAnkiTxt(txt);
      expect(notes).toHaveLength(2);
      expect(notes[0]).toEqual({ front: "Q1", back: "A1", tags: ["tag1"] });
      expect(notes[1].back).toBe("A2");
    });

    it("keeps blank lines and # lines inside a quoted field", () => {
      const txt = 'Q1\t"<pre>a\n\n# not a comment\nb</pre>"\nQ2\tA2';

      const notes = parseAnkiTxt(txt);
      expect(notes).toHaveLength(2);
      expect(notes[0].back).toBe("<pre>a\n\n# not a comment\nb</pre>");
    });

    it("leaves html fields as they are", () => {
      const txt = "#html:true\nWhat is <b>JSX</b>?\tA <i>syntax</i> extension";

      const notes = parseAnkiTxt(txt);
      expect(notes[0].front).toBe("What is <b>JSX</b>?");
      expect(notes[0].back).toBe("A <i>syntax</i> extension");
    });

    it("handles quoted fields with tabs inside", () => {
      const txt = '"What is\tJSX?"\tA syntax extension';

      const notes = parseAnkiTxt(txt);
      expect(notes[0].front).toBe("What is\tJSX?");
    });

    it("handles quoted fields with newlines inside", () => {
      const txt = '"What is\nJSX?"\tA syntax extension';

      const notes = parseAnkiTxt(txt);
      expect(notes[0].front).toBe("What is\nJSX?");
    });

    it("returns empty array for empty input", () => {
      expect(parseAnkiTxt("")).toEqual([]);
      expect(parseAnkiTxt("\n\n")).toEqual([]);
    });

    it("handles notes with only front (no back)", () => {
      const txt = "Just a front";
      const notes = parseAnkiTxt(txt);
      expect(notes.length).toBe(1);
      expect(notes[0].front).toBe("Just a front");
      expect(notes[0].back).toBe("");
    });

    it("handles #deck header", () => {
      const txt = "#separator:tab\n#deck:My Deck\nQ1\tA1";
      const notes = parseAnkiTxt(txt);
      expect(notes[0].deck).toBe("My Deck");
    });

    it("parses #deck column header", () => {
      const txt = "#separator:tab\n#deck column:3\nQ1\tA1\tReact\nQ2\tA2\tTypeScript";
      const notes = parseAnkiTxt(txt);
      expect(notes[0].deck).toBe("React");
      expect(notes[1].deck).toBe("TypeScript");
    });
  });

  // --- Export ---

  describe("exportCardsToAnkiTxt", () => {
    it("exports cards as tab-separated text with headers", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "A syntax extension", tags: ["react"] });
      await createCard({ deckId, front: "What is a hook?", back: "A function", tags: ["react", "hooks"] });

      const { cardCount, content } = await exportCardsToAnkiTxt();

      expect(cardCount).toBe(2);
      expect(content).toContain("#separator:tab");
      expect(content).toContain("#html:true");
      expect(content).toContain("#tags column:3");
      expect(content).toContain("#guid column:4");
      expect(content).toContain("#deck column:5");
      expect(content).toContain("What is JSX?\tA syntax extension\treact\t");
      expect(content).toContain("What is a hook?\tA function\treact hooks\t");
    });

    it("exports only the given deck", async () => {
      const other = await createDeck("Other");
      await createCard({ deckId, front: "Q1", back: "A1" });
      await createCard({ deckId: other.id, front: "Q2", back: "A2" });

      const { cardCount, content } = await exportCardsToAnkiTxt(other.id);
      expect(cardCount).toBe(1);
      expect(content).toContain("Q2\tA2");
      expect(content).not.toContain("Q1");
    });
  });

  describe("exportToAnkiTxt", () => {
    it("handles empty tags", async () => {
      const notes: AnkiNote[] = [
        { front: "Q", back: "A", tags: [] },
      ];

      const txt = exportToAnkiTxt(notes);
      const lines = txt.split("\n").filter((l) => !l.startsWith("#") && l.trim() !== "");
      expect(lines.length).toBe(1);
      // Tags column should be empty
      const fields = lines[0].split("\t");
      expect(fields[0]).toBe("Q");
      expect(fields[1]).toBe("A");
      expect(fields[2]).toBe("");
    });

    it("escapes tabs and newlines in content", () => {
      const notes: AnkiNote[] = [
        { front: "Line1\nLine2", back: "Has\ttab", tags: [] },
      ];

      const txt = exportToAnkiTxt(notes);
      const dataLines = txt.split("\n").filter((l) => !l.startsWith("#") && l.trim() !== "");
      // Quoted fields should contain the raw content
      expect(dataLines[0]).toContain('"');
    });

    it("round-trips through export then parse", async () => {
      const original: AnkiNote[] = [
        { front: "What is React?", back: "A UI library", tags: ["react", "fundamentals"], guid: "guid-1", deck: "React" },
        { front: "What is JSX?", back: "Syntax extension", tags: ["react"], guid: "guid-2", deck: "React" },
      ];

      const imported = parseAnkiTxt(exportToAnkiTxt(original));

      expect(imported).toEqual([
        { front: "What is React?", back: "A UI library", tags: ["react", "fundamentals"], deck: "React" },
        { front: "What is JSX?", back: "Syntax extension", tags: ["react"], deck: "React" },
      ]);
    });
  });

  // --- importTxtNotes ---

  describe("importTxtNotes", () => {
    it("round-trips a deck through export and import into an empty database", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "A syntax extension", tags: ["react"] });
      await createCard({ deckId, front: "What is a hook?", back: "A function", tags: ["react", "hooks"] });
      const { content } = await exportCardsToAnkiTxt();
      await getDb().card.deleteMany();

      // No --deck: each note goes to the deck its file names.
      const result = await importTxtNotes(parseAnkiTxt(content));

      expect(result).toEqual({ created: 2, updated: 0, duplicates: 0, invalid: 0 });
      const cards = await getDb().card.findMany({ where: { deckId }, orderBy: { front: "asc" } });
      expect(cards.map((c) => [c.front, c.back, c.tags])).toEqual([
        ["What is JSX?", "A syntax extension", "react"],
        ["What is a hook?", "A function", "react,hooks"],
      ]);
    });

    it("refuses notes that name no deck when none is given, writing nothing", async () => {
      await expect(importTxtNotes(parseAnkiTxt("Q1\tA1"))).rejects.toThrow(/name no deck/);
      expect(await getDb().card.count()).toBe(0);
    });

    it("skips duplicates by default", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer" });
      const notes = parseAnkiTxt("What is JSX?\tNew answer\nNew card\tSome answer");
      const result = await importTxtNotes(notes, { deck: "React" });
      expect(result).toEqual({ created: 1, updated: 0, duplicates: 1, invalid: 0 });
      const card = await getDb().card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("Old answer");
    });

    it("skips duplicates with conflict: ours", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer" });
      const notes = parseAnkiTxt("What is JSX?\tNew answer");
      const result = await importTxtNotes(notes, { deck: "React", conflict: "ours" });
      expect(result.duplicates).toBe(1);
      const card = await getDb().card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("Old answer");
    });

    it("overwrites back and tags with conflict: theirs", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer", tags: ["old"] });
      const notes = parseAnkiTxt("#separator:tab\n#tags column:3\nWhat is JSX?\tNew answer\tnew-tag");
      const result = await importTxtNotes(notes, { deck: "React", conflict: "theirs" });
      expect(result.updated).toBe(1);
      expect(result.duplicates).toBe(0);
      const card = await getDb().card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("New answer");
      expect(card.tags).toBe("new-tag");
    });

    it("keeps a card's tags when the file has no tags column (conflict: theirs)", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer", tags: ["keep"] });
      await importTxtNotes(parseAnkiTxt("What is JSX?\tNew answer"), { deck: "React", conflict: "theirs" });
      const card = await getDb().card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("New answer");
      expect(card.tags).toBe("keep");
    });

    it("clears a leech flag on an overwritten card (conflict: theirs)", async () => {
      const { card } = await createCard({ deckId, front: "What is JSX?", back: "Old answer" });
      await getDb().card.update({ where: { id: card.id }, data: { lapses: 6, leechFlaggedAt: new Date() } });

      await importTxtNotes(parseAnkiTxt("What is JSX?\tNew answer"), { deck: "React", conflict: "theirs" });

      const after = await getDb().card.findUniqueOrThrow({ where: { id: card.id } });
      expect(after.leechFlaggedAt).toBeNull();
      expect(after.lapses).toBe(0);
    });

    it("dry-run with conflict: theirs counts but does not update", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer" });
      const notes = parseAnkiTxt("What is JSX?\tNew answer");
      const result = await importTxtNotes(notes, { deck: "React", conflict: "theirs", dryRun: true });
      expect(result.updated).toBe(1);
      const card = await getDb().card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("Old answer");
    });

    it("dry-run into a deck that does not exist creates no deck", async () => {
      const result = await importTxtNotes(parseAnkiTxt("Q1\tA1"), { deck: "Fresh", dryRun: true });
      expect(result.created).toBe(1);
      expect(await getDb().deck.count({ where: { name: "Fresh" } })).toBe(0);
    });

    it("creates a repeated front once and counts the repeat as a duplicate", async () => {
      const result = await importTxtNotes(parseAnkiTxt("Q1\tA1\nQ1\tA2"), { deck: "React" });
      expect(result).toEqual({ created: 1, updated: 0, duplicates: 1, invalid: 0 });
      const cards = await getDb().card.findMany({ where: { deckId } });
      expect(cards.map((c) => c.back)).toEqual(["A1"]);
    });

    it("counts empty fronts and rule-breaking content as invalid and imports the rest", async () => {
      const notes = parseAnkiTxt("\tno front\nUses **markdown**\tA1\nQ2\tA2");
      const result = await importTxtNotes(notes, { deck: "React" });
      expect(result).toEqual({ created: 1, updated: 0, duplicates: 0, invalid: 2 });
      const cards = await getDb().card.findMany({ where: { deckId } });
      expect(cards.map((c) => c.front)).toEqual(["Q2"]);
    });

    it("imports more notes than the intake threshold in one run", async () => {
      const txt = Array.from({ length: PAUSE_NEW_TODAY + 5 }, (_, i) => `Q${i}\tA${i}`).join("\n");
      const result = await importTxtNotes(parseAnkiTxt(txt), { deck: "React" });

      expect(result.created).toBe(PAUSE_NEW_TODAY + 5);
      expect(await getDb().card.count({ where: { deckId } })).toBe(PAUSE_NEW_TODAY + 5);
    });

    it("refuses atomically when intake is already at pause, writing nothing", async () => {
      const db = getDb();
      await db.card.createMany({
        data: Array.from({ length: PAUSE_NEW_TODAY }, (_, i) => ({
          deckId,
          front: `today ${i}`,
          back: "a",
        })),
      });

      const notes = parseAnkiTxt("Q1\tA1\nQ2\tA2\nQ3\tA3");
      await expect(importTxtNotes(notes, { deck: "React" })).rejects.toThrow(/cards added today/);

      expect(await db.card.count({ where: { front: { startsWith: "Q" } } })).toBe(0);
    });

    it("refuses atomically when the review backlog is at pause, writing nothing", async () => {
      const db = getDb();
      await db.card.createMany({
        data: Array.from({ length: PAUSE_FLASHCARDS }, (_, i) => ({
          deckId,
          front: `backlog ${i}`,
          back: "a",
          state: State.Review,
          due: new Date(Date.now() - 60_000),
          createdAt: new Date(Date.now() - 24 * 3600 * 1000),
        })),
      });

      const notes = parseAnkiTxt("Q1\tA1\nQ2\tA2\nQ3\tA3");
      await expect(importTxtNotes(notes, { deck: "React" })).rejects.toThrow(/Card creation blocked/);

      expect(await db.card.count({ where: { front: { startsWith: "Q" } } })).toBe(0);
    });

    it("dry-run is refused at pause too, so it never promises an unreachable count", async () => {
      await getDb().card.createMany({
        data: Array.from({ length: PAUSE_NEW_TODAY }, (_, i) => ({
          deckId,
          front: `today ${i}`,
          back: "a",
        })),
      });

      const notes = parseAnkiTxt("Q1\tA1");
      await expect(importTxtNotes(notes, { deck: "React", dryRun: true })).rejects.toThrow(
        /Card creation blocked/
      );
    });

    it("updates at pause, since overwriting adds no card", async () => {
      const db = getDb();
      await db.card.createMany({
        data: Array.from({ length: PAUSE_NEW_TODAY }, (_, i) => ({ deckId, front: `today ${i}`, back: "a" })),
      });

      const result = await importTxtNotes(parseAnkiTxt("today 0\tb"), { deck: "React", conflict: "theirs" });
      expect(result.updated).toBe(1);
    });
  });
});
