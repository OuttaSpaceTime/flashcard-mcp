# master-dev

A spaced repetition system (SRS) for software engineering mastery, built with TypeScript, Prisma/SQLite, and FSRS scheduling.

## Features

- **FSRS scheduling** — state-of-the-art spaced repetition algorithm via `ts-fsrs`
- **Semantic duplicate detection** — two-stage Jaccard + cosine similarity on 384-dim embeddings
- **Anki interop** — import/export `.apkg` (including zstd-compressed `collection.anki21b`) and plain-text `.txt` formats
- **MCP server** — 18 tools exposable to Claude via Model Context Protocol
- **CLI** — `init`, `study`, `stats`, `decks`, `cards`, `import`, `export`, `embeddings`
- **Anti-overload** — caps new cards at 5 and reviews at 15 per session; requires explicit draft approval

## Setup

```bash
npm install
npx prisma db push      # create the SQLite database
npx prisma generate     # generate Prisma client
```

## Usage

### CLI

```bash
npm run dev:cli -- init              # initialize a default deck
npm run dev:cli -- study             # start a study session
npm run dev:cli -- stats             # show retention and streak stats
npm run dev:cli -- decks             # list all decks
npm run dev:cli -- cards             # list cards
npm run dev:cli -- import file.txt   # import Anki plain-text export
npm run dev:cli -- export            # export cards to Anki plain-text
npm run dev:cli -- embeddings        # backfill semantic embeddings
```

### MCP server

```bash
npm run dev:mcp    # stdio transport — connect from Claude Code or any MCP client
```

Configure in your MCP client (example for Claude Code `settings.json`):

```json
{
  "mcpServers": {
    "master-dev-srs": {
      "command": "npx",
      "args": ["tsx", "/path/to/master-dev/src/mcp/server.ts"]
    }
  }
}
```

## Claude Code skills

The repo ships two Claude Code skills in `.claude/skills/`. With the MCP server running, these give you an interactive study workflow directly in Claude Code.

### `/study`

An interactive study session where Claude acts as evaluator — you answer, Claude rates. No self-rating required.

```
/study                    — Start a default session (5 new + 15 review cards)
/study react              — Focus on a specific deck
/study --short            — Quick 5-card session
/study add                — Skip straight to creating new flashcards
```

During a session you can interrupt at any point:

| Command | What happens |
|---|---|
| `discuss` / `why?` | Claude explains the concept in depth, then resumes |
| `walkthrough` | Full deep-dive on the current card's topic, then resumes |
| `edit` | Fix the card front/back/tags on the spot |
| `split` | Break an overloaded card into focused sub-cards |
| `skip` | Skip without reviewing |
| `fewer` | Trim the remaining queue |
| `add` | Create new flashcards mid-session, then resume |
| `done` | End early and show summary |

### `/flashcard`

A guided 4-checkpoint walkthrough for creating new cards. Every draft is checked for semantic duplicates before creation.

```
/flashcard                          — Interactive creation (asks for topic and deck)
/flashcard react closures           — Target a specific topic and deck
/flashcard --from <url>             — Extract concepts from a URL or file
/flashcard <text or paragraph>      — Paste notes/docs and Claude extracts 2-3 key concepts
```

Checkpoints: **scope** → **concept walkthrough** → **draft review + duplicate check** → **confirm and create**. Cards are never created without your explicit approval.

### Prerequisites

Both skills require the MCP server to be running and connected. See the [MCP server](#mcp-server) section above for setup.

## Anki interop

### `.apkg` import

```bash
npm run dev:cli -- import collection.apkg
npm run dev:cli -- import collection.apkg --dry-run   # preview without creating cards
```

An `.apkg` file is a ZIP containing a SQLite database. Three database variants are supported:

| File inside ZIP | Anki version | Encoding |
|---|---|---|
| `collection.anki21b` | Anki 2.1.50+ | zstd-compressed SQLite |
| `collection.anki21` | Anki 2.1.x | plain SQLite |
| `collection.anki2` | Anki 2.0 (legacy) | plain SQLite |

The most recent variant found takes precedence.

**Scheduling data** is preserved on import:

- Cards exported from Anki with its native FSRS scheduler store parameters in `card.data` JSON (`{"s": stability, "d": difficulty}`). These are used directly.
- Cards using the classic SM-2 scheduler are converted: interval → FSRS stability, ease factor (permille) → FSRS difficulty (1–10 scale).
- Review history (ratings, timestamps, response times) is imported for all cards.

Deck names and hierarchy are read from the `decks` table (schema v18+) or the `col.decks` JSON column (schema v11), so your deck structure is preserved.

The `--deck` flag is ignored for `.apkg` imports — deck names come from the file itself.

**Conflict resolution on re-import** — when a card with the same front already exists in the deck:

```bash
npm run dev:cli -- import file.apkg                 # default: keep local (same as --ours)
npm run dev:cli -- import file.apkg --ours          # explicitly keep local version
npm run dev:cli -- import file.apkg --theirs        # overwrite local with imported version
npm run dev:cli -- import file.apkg --theirs --dry-run  # preview what would change
```

`--theirs` overwrites `back`, `tags`, and all scheduling fields (`stability`, `difficulty`, `state`, `reps`, `lapses`, `due`, `interval`). New cards are always created regardless of conflict mode. `--ours` and `--theirs` are mutually exclusive.

### `.apkg` export

```bash
npm run dev:cli -- export output.apkg           # all decks
npm run dev:cli -- export output.apkg -d react  # single deck
```

Exports a standard `collection.anki21` database (uncompressed SQLite) inside a ZIP. FSRS parameters are converted back to SM-2 so the file is compatible with Anki's default scheduler. Review history is included.

### Plain-text `.txt` import/export

```bash
npm run dev:cli -- import cards.txt -d MyDeck          # Anki "Notes in Plain Text" format
npm run dev:cli -- import cards.txt -d MyDeck --theirs  # overwrite duplicates
npm run dev:cli -- export cards.txt                    # export all cards
```

Tab-separated format with `#separator`, `#html`, and `#tags` header directives. No scheduling data — cards are imported as new. The same `--ours`/`--theirs` conflict flags apply; `--theirs` overwrites `back` and `tags` on matching cards.

## Development

```bash
npm test                # run all tests (vitest)
npm run typecheck       # TypeScript strict mode check
npm run lint            # ESLint
npm run build           # compile to build/
```

## License

MIT
