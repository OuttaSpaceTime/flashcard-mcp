# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Verify

```bash
npm test                          # Run all 119 tests (vitest)
npx vitest run __tests__/core/scheduler.test.ts  # Run single test file
npx vitest run -t "creates a card" # Run tests matching name pattern
npm run typecheck                 # TypeScript strict mode check (must be clean)
npm run lint                      # ESLint (0 errors required, warnings acceptable)
npm run lint:fix                  # Auto-fix lint issues
npm run build                     # Compile to build/
```

**Verification workflow:** always run in this order: `npm test && npm run typecheck && npm run lint`

## Database

SQLite via Prisma. DB file at `prisma/master.db`, URL configured via `DATABASE_URL` env var (defaults in `.env`).

```bash
npx prisma db push                # Sync schema.prisma → SQLite (after schema changes)
npx prisma generate               # Regenerate Prisma client (after schema changes)
```

Tests use isolated temp SQLite databases created per test suite in `__tests__/setup.ts`. They call `setDb()` to inject the test client — production code accesses the DB via `getDb()` from `src/db/client.ts`.

## Running

```bash
npm run dev:cli -- <command>       # CLI: init, study, stats, decks, cards, topics, import, export, embeddings
npm run dev:mcp                    # MCP server (stdio transport, configured in .claude/settings.json)
```

## Architecture

Three interfaces share one core library:

```
CLI (src/cli/index.ts)  ──┐
MCP (src/mcp/server.ts) ──┼── Core services (src/core/*) ── Prisma/SQLite
/study skill            ──┘
```

**Core modules** (`src/core/`):
- `scheduler.ts` — ts-fsrs wrapper. Pure functions, no DB. `reviewCard()` applies a rating, `getRetrievability()` returns recall probability. Uses `Grade` type from ts-fsrs (not `Rating` — `Grade` excludes the `Manual` variant).
- `card-service.ts` — Card CRUD, duplicate detection (Jaccard + semantic embeddings), `backfillEmbeddings()`, `findSimilar()`, `getDueCards()`.
- `session-service.ts` — Study session lifecycle. Queues stored in-memory (module-level Maps). Anti-overload: caps new cards at 5, review at 15, reduces new cards when reviews > 10.
- `embeddings.ts` — Two-stage similarity: `jaccardSimilarity()` (always available) + `cosineSimilarity()` on 384-dim vectors from `@huggingface/transformers` (lazy-loaded, ~30s first call). `findSimilarCards()` accepts optional `SemanticOptions` for the embedding stage.
- `anki-apkg.ts` — Import/export `.apkg` files with full scheduling. Handles `collection.anki21b` (zstd-compressed SQLite) via `fzstd`. Converts between Anki SM-2 fields and FSRS, and reads native FSRS data from card.data JSON when present.
- `anki-io.ts` — Import/export Anki "Notes in Plain Text" (`.txt`) format. Tab-separated with `#header` directives.
- `analytics-service.ts` — `getFullStats()` aggregates streak, retention, maturity, lapses in parallel.
- `types.ts` — Shared types, `parseTags()`/`serializeTags()` utilities.

**MCP server** exposes ~18 tools. Tool arguments are accessed via typed `arg<T>(args, key)` / `reqArg<T>(args, key)` helpers (not `as any`). **`.txt` import/export is CLI-only** — `import_anki_txt` and `export_anki_txt` are intentionally absent from the MCP server. `.apkg` import/export is also CLI-only (file I/O); the MCP server handles in-memory card operations only.

**Skills** (in `~/.claude/skills/`):
- `/study` — Interactive review sessions. Claude evaluates answers and rates them.
- `/flashcard` — Create SRS flashcards through a 4-checkpoint walkthrough with semantic duplicate detection.

## Key Design Decisions

**Anti-overload:** Never auto-generate cards. Drafts require explicit approval. Default 2-3 cards per creation session. Practice-first mode prioritizes exercises over flashcards.

**Internalized cards:** Stay active at lower review frequency (FSRS stability handles natural spacing). Never removed — use `maturity: "internalized"` field.

**Duplicate detection:** Two-stage — Jaccard word-overlap (fast, always on) then cosine similarity on embeddings (requires `initEmbeddings()` first load). Thresholds: Jaccard ≥ 0.50 for warning, cosine ≥ 0.45 for semantic match.

**Anki interop:** `.apkg` import handles both legacy `collection.anki2` and modern `collection.anki21b` (zstd-compressed). Cards with native FSRS data in `card.data` JSON are used directly; SM-2 cards are converted via `convertSM2toFSRS()`.

## Lint Rules to Know

- `strict-boolean-expressions` (warn): No implicit truthy checks on strings/numbers. Use explicit `!== ""`, `!== 0`, `!= null`.
- `no-floating-promises` (error): Must `await`, `.catch()`, or `void` all promises.
- `consistent-type-imports` (error): Use `import type { Foo }` or `import { type Foo }`.
- `eqeqeq` (error, null-exempt): Use `===`/`!==` except for `== null` / `!= null`.

## Test-First Workflow

Write tests before implementation. Tests use a fresh temp SQLite DB per suite (see `__tests__/setup.ts`). Test files mirror source structure: `__tests__/core/scheduler.test.ts` tests `src/core/scheduler.ts`.
