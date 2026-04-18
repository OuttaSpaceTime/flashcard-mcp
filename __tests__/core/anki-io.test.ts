import { describe, it, expect, beforeEach } from "vitest";
import {
  exportToAnkiTxt,
  parseAnkiTxt,
  importTxtNotes,
  type AnkiNote,
} from "../../src/core/anki-io.js";
import { createDeck } from "../../src/core/deck-service.js";
import { createCard } from "../../src/core/card-service.js";
import { getDb } from "../../src/db/client.js";

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

    it("parses guid from designated column", () => {
      const txt = "#separator:tab\n#guid column:3\nWhat is JSX?\tA syntax ext\tabc-123\nWhat is a hook?\tA function\tdef-456";

      const notes = parseAnkiTxt(txt);
      expect(notes[0].guid).toBe("abc-123");
      expect(notes[1].guid).toBe("def-456");
    });

    it("handles tags and guid columns together", () => {
      const txt = "#separator:tab\n#tags column:3\n#guid column:4\nQ1\tA1\ttag1\tguid-1\nQ2\tA2\ttag2 tag3\tguid-2";

      const notes = parseAnkiTxt(txt);
      expect(notes[0].tags).toEqual(["tag1"]);
      expect(notes[0].guid).toBe("guid-1");
      expect(notes[1].tags).toEqual(["tag2", "tag3"]);
      expect(notes[1].guid).toBe("guid-2");
    });

    it("skips empty lines and comment lines", () => {
      const txt = "#separator:tab\n\nQ1\tA1\n\n# this is a comment\nQ2\tA2\n";

      const notes = parseAnkiTxt(txt);
      expect(notes.length).toBe(2);
    });

    it("handles html:true header (content unchanged)", () => {
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

    it("handles #notetype header", () => {
      const txt = "#separator:tab\n#notetype:Basic\nQ1\tA1";
      const notes = parseAnkiTxt(txt);
      expect(notes[0].notetype).toBe("Basic");
    });

    it("parses #notetype column header", () => {
      const txt = "#separator:tab\n#notetype column:3\nQ1\tA1\tBasic\nQ2\tA2\tCloze";
      const notes = parseAnkiTxt(txt);
      expect(notes[0].notetype).toBe("Basic");
      expect(notes[1].notetype).toBe("Cloze");
    });

    it("parses #deck column header", () => {
      const txt = "#separator:tab\n#deck column:3\nQ1\tA1\tReact\nQ2\tA2\tTypeScript";
      const notes = parseAnkiTxt(txt);
      expect(notes[0].deck).toBe("React");
      expect(notes[1].deck).toBe("TypeScript");
    });
  });

  // --- Export ---

  describe("exportToAnkiTxt", () => {
    it("exports cards as tab-separated text with headers", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "A syntax extension", tags: ["react"] });
      await createCard({ deckId, front: "What is a hook?", back: "A function", tags: ["react", "hooks"] });

      const db = getDb();
      const cards = await db.card.findMany({
        include: { deck: { select: { name: true } } },
      });

      const txt = exportToAnkiTxt(
        cards.map((c) => ({
          front: c.front,
          back: c.back,
          tags: c.tags ? c.tags.split(",").filter(Boolean) : [],
          guid: c.id,
          deck: c.deck.name,
        }))
      );

      expect(txt).toContain("#separator:tab");
      expect(txt).toContain("#html:true");
      expect(txt).toContain("#tags column:3");
      expect(txt).toContain("#guid column:4");
      expect(txt).toContain("#deck column:5");
      expect(txt).toContain("What is JSX?\tA syntax extension\treact\t");
      expect(txt).toContain("What is a hook?\tA function\treact hooks\t");
    });

    it("handles empty tags", async () => {
      const notes: AnkiNote[] = [
        { front: "Q", back: "A", tags: [] },
      ];

      const txt = exportToAnkiTxt(notes);
      const lines = txt.split("\n").filter((l) => !l.startsWith("#") && l.trim());
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
      const dataLines = txt.split("\n").filter((l) => !l.startsWith("#") && l.trim());
      // Quoted fields should contain the raw content
      expect(dataLines[0]).toContain('"');
    });

    it("round-trips through export then import", async () => {
      const original: AnkiNote[] = [
        { front: "What is React?", back: "A UI library", tags: ["react", "fundamentals"], guid: "guid-1", deck: "React" },
        { front: "What is JSX?", back: "Syntax extension", tags: ["react"], guid: "guid-2", deck: "React" },
      ];

      const exported = exportToAnkiTxt(original);
      const imported = parseAnkiTxt(exported);

      expect(imported.length).toBe(2);
      expect(imported[0].front).toBe("What is React?");
      expect(imported[0].back).toBe("A UI library");
      expect(imported[0].tags).toEqual(["react", "fundamentals"]);
      expect(imported[0].guid).toBe("guid-1");
      expect(imported[0].deck).toBe("React");
      expect(imported[1].front).toBe("What is JSX?");
      expect(imported[1].guid).toBe("guid-2");
    });
  });

  // --- importTxtNotes ---

  describe("importTxtNotes", () => {
    it("skips duplicates by default", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer" });
      const notes = parseAnkiTxt("What is JSX?\tNew answer\nNew card\tSome answer");
      const result = await importTxtNotes(notes, deckId, {});
      expect(result.created).toBe(1);
      expect(result.duplicates).toBe(1);
      const db = getDb();
      const card = await db.card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("Old answer");
    });

    it("skips duplicates with conflict: ours", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer" });
      const notes = parseAnkiTxt("What is JSX?\tNew answer");
      const result = await importTxtNotes(notes, deckId, { conflict: "ours" });
      expect(result.duplicates).toBe(1);
      const db = getDb();
      const card = await db.card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("Old answer");
    });

    it("overwrites back and tags with conflict: theirs", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer", tags: ["old"] });
      const notes = parseAnkiTxt("#separator:tab\n#tags column:3\nWhat is JSX?\tNew answer\tnew-tag");
      const result = await importTxtNotes(notes, deckId, { conflict: "theirs" });
      expect(result.updated).toBe(1);
      expect(result.duplicates).toBe(0);
      const db = getDb();
      const card = await db.card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("New answer");
      expect(card.tags).toBe("new-tag");
    });

    it("dry-run with conflict: theirs counts but does not update", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Old answer" });
      const notes = parseAnkiTxt("What is JSX?\tNew answer");
      const result = await importTxtNotes(notes, deckId, { conflict: "theirs", dryRun: true });
      expect(result.updated).toBe(1);
      const db = getDb();
      const card = await db.card.findFirstOrThrow({ where: { deckId, front: "What is JSX?" } });
      expect(card.back).toBe("Old answer");
    });
  });

  // --- Full import workflow ---

  describe("import workflow (parse → deduplicate → create)", () => {
    it("imports notes into a deck, skipping duplicates", async () => {
      // Pre-existing card
      await createCard({ deckId, front: "What is JSX?", back: "Old answer" });

      const txt = "What is JSX?\tNew answer\nWhat is a hook?\tA function";
      const notes = parseAnkiTxt(txt);

      const db = getDb();
      let created = 0;
      let skipped = 0;

      for (const note of notes) {
        const existing = await db.card.findFirst({
          where: { deckId, front: note.front },
        });

        if (existing) {
          skipped++;
        } else {
          await createCard({
            deckId,
            front: note.front,
            back: note.back,
            tags: note.tags,
          });
          created++;
        }
      }

      expect(created).toBe(1);
      expect(skipped).toBe(1);

      const allCards = await db.card.findMany({ where: { deckId } });
      expect(allCards.length).toBe(2);
    });
  });
});
