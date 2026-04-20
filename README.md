# flashcard-mcp

A spaced-repetition flashcard system with an MCP server and CLI, built on TypeScript, Prisma/SQLite, and FSRS scheduling.

## Features

- **FSRS scheduling** — state-of-the-art spaced repetition via `ts-fsrs`
- **MCP server** — 21 tools for sessions, cards, decks, stats, and duplicate detection over stdio
- **CLI** — `init`, `decks`, `cards`, `categories`, `study`, `stats`, `topics`, `import`, `export`, `embeddings`, `db:dump`, `db:restore`
- **Semantic duplicate detection** — two-stage Jaccard + cosine similarity on 384-dim embeddings
- **Anki interop** — import/export `.apkg` (including zstd-compressed `collection.anki21b`) with full scheduling, plus plain-text `.txt`
- **Categories** — tag cards as e.g. `work` or `personal` and filter sessions/lists accordingly
- **Anti-overload** — caps new cards at 5 and reviews at 15 per session; card creation requires explicit approval

## Setup

```bash
npm install
npx prisma db push      # create the SQLite database
npx prisma generate     # generate Prisma client
npm run dev:cli -- init # create default decks
```

## CLI

```bash
npm run dev:cli -- init                       # create default decks + config
npm run dev:cli -- decks                      # list decks with stats
npm run dev:cli -- cards add <deck> -f ... -b ...   # add a card
npm run dev:cli -- cards list [--deck X] [--category work] [--uncategorized] [--due]
npm run dev:cli -- cards search <query>
npm run dev:cli -- categories list            # categories in use, with counts
npm run dev:cli -- categories add <name> --deck X | --card <id>
npm run dev:cli -- study [--deck X] [--category work] [--limit N]
npm run dev:cli -- stats                      # streak, retention, maturity, lapses
npm run dev:cli -- topics                     # maturity report per deck
npm run dev:cli -- import <file> [--deck X] [--ours|--theirs] [--dry-run]
npm run dev:cli -- export <file> [--deck X]
npm run dev:cli -- embeddings status
npm run dev:cli -- embeddings backfill
npm run dev:cli -- db:dump <file>             # portable SQL dump
npm run dev:cli -- db:restore <file> [--force]
```

After `npm run build`, the CLI is available as the `master` binary.

## MCP server

```bash
npm run dev:mcp    # stdio transport — connect from Claude Code or any MCP client
```

Example Claude Code configuration:

```json
{
  "mcpServers": {
    "flashcard-mcp": {
      "command": "npx",
      "args": ["tsx", "/path/to/flashcard-mcp/src/mcp/server.ts"]
    }
  }
}
```

### Tools exposed

Sessions: `start_session`, `get_next_card`, `submit_review`, `skip_card`, `adjust_session`
Cards: `create_card`, `get_card`, `update_card`, `delete_card`, `delete_cards`, `list_cards`, `search_cards`, `suspend_card`, `unsuspend_card`, `find_similar_cards`, `get_due_cards`
Decks & stats: `list_decks`, `get_deck_stats`, `delete_deck`, `get_stats`, `get_session_history`

File I/O tools (`.apkg` / `.txt` import + export, DB dump/restore) are intentionally CLI-only — the MCP server handles in-memory card operations only.

## Anki interop

### `.apkg` import

```bash
npm run dev:cli -- import collection.apkg
npm run dev:cli -- import collection.apkg --dry-run   # preview without creating cards
```

An `.apkg` file is a ZIP containing a SQLite database. Three variants are supported:

| File inside ZIP | Anki version | Encoding |
|---|---|---|
| `collection.anki21b` | Anki 2.1.50+ | zstd-compressed SQLite |
| `collection.anki21` | Anki 2.1.x | plain SQLite |
| `collection.anki2` | Anki 2.0 (legacy) | plain SQLite |

The most recent variant found takes precedence. Deck names and hierarchy come from the file itself, so `--deck` is ignored for `.apkg` imports.

**Scheduling data** is preserved:

- Cards exported from Anki with its native FSRS scheduler store parameters in `card.data` JSON (`{"s": stability, "d": difficulty}`). Used directly.
- Classic SM-2 cards are converted: interval → FSRS stability, ease factor → FSRS difficulty (1–10 scale).
- Review history (ratings, timestamps, response times) is imported for all cards.

**Conflict resolution on re-import** — when a card with the same front exists in the deck:

```bash
npm run dev:cli -- import file.apkg                      # default: keep local (--ours)
npm run dev:cli -- import file.apkg --theirs             # overwrite local with imported
npm run dev:cli -- import file.apkg --theirs --dry-run   # preview changes
```

`--theirs` overwrites `back`, `tags`, and all scheduling fields. New cards are always created regardless of conflict mode. `--ours` and `--theirs` are mutually exclusive.

### `.apkg` export

```bash
npm run dev:cli -- export output.apkg           # all decks
npm run dev:cli -- export output.apkg -d react  # single deck
```

Exports a standard `collection.anki21` database (uncompressed SQLite) inside a ZIP. FSRS parameters are converted back to SM-2 so the file opens in Anki's default scheduler. Review history included.

### Plain-text `.txt` import/export

```bash
npm run dev:cli -- import cards.txt -d MyDeck           # Anki "Notes in Plain Text"
npm run dev:cli -- import cards.txt -d MyDeck --theirs  # overwrite duplicates
npm run dev:cli -- export cards.txt                     # export all cards
```

Tab-separated format with `#separator`, `#html`, and `#tags` header directives. No scheduling data — cards are imported as new. The same `--ours`/`--theirs` conflict flags apply.

## Development

```bash
npm test              # vitest
npm run typecheck     # TypeScript strict mode
npm run lint          # ESLint
npm run build         # compile to build/
```

Tests use isolated temp SQLite databases per suite (see `__tests__/setup.ts`) and inject the client via `setDb()`. Production code accesses the DB through `getDb()` in `src/db/client.ts`.

## License

MIT
