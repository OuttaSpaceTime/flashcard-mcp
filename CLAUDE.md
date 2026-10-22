# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Verify

```bash
npm test                          # Run all tests (vitest)
npx vitest run __tests__/core/scheduler.test.ts  # Run single test file
npx vitest run -t "creates a card" # Run tests matching name pattern
npm run typecheck                 # TypeScript strict mode over src/ and __tests__/ (tsconfig.test.json; must be clean)
npm run lint                      # ESLint over src/ and __tests__/ (0 errors required, warnings acceptable)
npm run lint:fix                  # Auto-fix lint issues
npm run build                     # Compile to build/
```

**Verification workflow:** always run in this order: `npm test && npm run typecheck && npm run lint`

## Database

SQLite via Prisma. DB file at `prisma/master.db`, URL from the `DATABASE_URL` env var, else that default (`databaseUrl()` in `src/db/client.ts`, the one place it is resolved). A relative `file:` path resolves against the repo root, never the working directory, so a server started from elsewhere cannot create a stray empty database. `prisma` and `dotenv` are runtime dependencies: every start may run `prisma db push`, which loads `prisma.config.ts`.

```bash
npx prisma generate               # Regenerate Prisma client (after schema changes)
npm run dev:cli -- db:sync        # Push schema.prisma to the database now (every start does it anyway)
```

**Schema changes apply themselves.** Every start of the CLI, the MCP server and the app server runs `prepareDatabase` (`src/db/prepare.ts`): `syncSchema` (`src/db/schema-sync.ts`) compares a fingerprint of `schema.prisma` with the one stored in the database's `PRAGMA user_version`, and on a difference backs the file up beside itself (`<db>.bak-<time>-schema`) and runs `prisma db push` against the URL the client was opened with; then `normalizeDates`. So a new table or column needs no step on any machine, and no code has to cope with it missing. A change that would lose data (dropping a column) is refused by db push, which fails the start with Prisma's message and leaves the database alone: run `npx prisma db push --accept-data-loss` by hand for those, on every machine. Don't use `user_version` for anything else; `db:dump` carries it over so a restored database doesn't push again.

Tests use isolated temp SQLite databases created per test suite in `__tests__/setup.ts`, built through `syncSchema` like a real start. They call `setDb()` to inject the test client — production code accesses the DB via `getDb()` from `src/db/client.ts`. Vitest globals are off: import `describe`/`it`/`expect` from `"vitest"`.

## Running

```bash
npm run dev:cli -- <command>       # CLI: init, study, stats, calibration, overview, decks, cards, categories, maturity, import, export, embeddings, db:dump, db:restore, db:sync
npm run dev:mcp                    # MCP server (stdio transport; see README for the Claude Code config)
npm run dev:app                    # App server for the Omvida GUI (JSON lines over stdio)
```

## Architecture

Four interfaces share one core library:

```
CLI (src/cli/index.ts)  ──┐
MCP (src/mcp/server.ts) ──┤
App (src/app/server.ts) ──┼── Core services (src/core/*) ── Prisma/SQLite
/study skill            ──┘
```

**The app server** (`src/app/`) is the Omvida desktop app's connection (`~/Code/omvida`): newline-delimited JSON over stdio, `{id, method, params}` in and `{id, result|error}` out, plus a `{"ready": true}` line at start. Not MCP, which would make a QML client implement the handshake and result envelopes for nothing it needs; not the CLI per call, because each start costs about a second. `handlers.ts` is a thin method table (the /study loop's tools reshaped for a GUI) that never touches Prisma itself, and differs from the MCP tools in these deliberate ways: `startSession` derives `maxNewCards` from the pressure verdict itself (ok → default, warn/pause → 0, /study's Phase 2 table); `nextCard` returns a leech block as data (`{blocked: {card, lapses}}`, from core `getNextCardOrBlock`) instead of throwing, since a GUI needs the card to show the ways out; `nextCard` also carries `schedules`, what each rating would schedule (`previewSchedules` in session-service, the same FSRS step and intra-day rule as `submitReview`), for the app's rating keys; and `grade` suggests a rating (grading.ts). `stamp` comes from `changeTokens()` (`src/core/change-tokens.ts`). `src/core/overview.ts` builds the progress picture (pressure, calibration, streak, maturity over unsuspended cards so the buckets sum to `totalCards`, the last seven local days of reviews, pending review cards) that both the app and `master overview` (the bar widget's source) print; it passes the pressure and calibration verdicts through whole, never recomputing them. Requests run concurrently, so a grade never holds up a page of cards.

**Maturity is derived, never stored.** Call `cardMaturity(card)` (scheduler.ts) at the point of display. A stored column once existed; it was set at creation and never updated on review, so it reported cards with 38 reps and 2229 days of stability as `new`.

**Day boundaries are local.** Every day key (streak, intake, the overview's week, calibration's one-review-per-card-per-day rule) comes from `src/core/days.ts` (`localDay`, `startOfLocalDay`, `MS_PER_DAY`), never from UTC dates. The one exception is `Review.elapsedDays`, ts-fsrs's UTC day difference, which calibration's `elapsedDays >= 1` filter keeps deliberately (documented on `eligibleReviews`).

**Core modules** (`src/core/`):
- `scheduler.ts` — ts-fsrs wrapper. Pure functions, no DB. `reviewCard()` applies a rating at a given request retention (`Config.requestRetention`, default 0.9, which `submitReview` and `previewSchedules` pass in), `getRetrievability()` returns recall probability, `cardMaturity()` derives new/learning/familiar/internalized from `state` + `interval` (mature at `MATURE_INTERVAL_DAYS`, Anki's 21-day convention). Uses `Grade` type from ts-fsrs (not `Rating` — `Grade` excludes the `Manual` variant); `isGrade()` is the one check that a rating is 1–4. Import `State`/`Rating`/`Grade` from ts-fsrs directly.
- `card-service.ts` — Card CRUD, duplicate detection (Jaccard + semantic embeddings), `backfillEmbeddings()`, `findSimilar()`, `getDueCards()`/`countDueCards()`, `listCards()`/`searchCards()` (tags match exactly; both return the deck name). Every deletion (`deleteCard`, `deleteCards`, `deleteDeck`) writes a `DeletedCard` tombstone through `tombstone()`, so the external anki-sync can tell a local delete from a card created elsewhere.
- `deck-service.ts` — Deck CRUD; `listDeckStats()` gives every deck's counts in 3 queries total.
- `card-import.ts` — The one import loop behind both `.apkg` and `.txt`: `importCards()` returns `{created, updated, duplicates, invalid}`. One lookup per deck; the first occurrence of a front wins and repeats count as duplicates; content rules apply per card and failures count as invalid; pressure is checked once and only when the batch creates New cards (cards arriving with a schedule count like splits); writes go through `createCard`/`updateCard` (so embeddings refresh and `--theirs` clears leech flags); a dry run writes nothing, decks included.
- `content-rules.ts` — `assertCardContent()` gates every create/update: fields are simple HTML (markdown is rejected, Anki shows it literally), no em dashes, fronts ask a single question, answers capped at `MAX_ANSWER_CHARS` and a sentence count, both measured on rendered text; `visibleText()` for display.
- `session-service.ts` — Study session lifecycle. An open session's queue and position are saved in `StudySession.queueState` (JSON) on every change and cached per process, so a session survives a restart of the MCP server or the app server and any process can resume it; one process drives a session at a time. `endSession` and an exhausted queue clear it. Anti-overload: caps from the `Config` row (schema defaults: 5 new, 15 review; the row is created on first read), reduces new cards when reviews > 10. `startSession` filters by `category` and/or `deckId` (both also bound new-card top-ups) and returns `newCount`/`reviewCount`. `submitReview` writes the card, the review and the session in one transaction and throws when the session isn't open (ended, exhausted, unknown); accuracy is Good/Easy over reviews submitted, so skips don't count. **`endTime` means "the session was ended" — `submitReview` does not touch it**, nor the card's `updatedAt`, which means "the content was edited" (the app server's `stamp` counts reviews apart), so a null `endTime` is a session that was never closed rather than one that is merely idle. Close with `endSession()` (idempotent; returns a `SessionSummary` with ISO dates; the `end_session` MCP tool). `startSession()` first discards sessions that reviewed nothing, since those carry no information; sessions that did review cards are left open rather than back-stamped, because inventing an end time would invent a duration. The CLI `study` ends its session once it has reviewed anything.
- `embeddings.ts` — Two-stage similarity: `jaccardSimilarity()` (always available) + `cosineSimilarity()` on 384-dim vectors from `@huggingface/transformers` (lazy-loaded, ~30s first call; a failed load is not retried per call). `findSimilarCards()` accepts optional `SemanticOptions` for the embedding stage. Thresholds are the named constants here (see Duplicate detection).
- `anki-apkg.ts` — Import/export `.apkg` files with full scheduling. `readApkg()` opens the collection from memory, handling `collection.anki21b` (zstd-compressed SQLite) via `fzstd`; carries suspension (queue -1); due dates from day numbers, or epoch seconds for intraday learning; skips ease-0 revlog rows and derives `elapsedDays` from the gap between reviews. Converts between Anki SM-2 fields and FSRS, and reads native FSRS data from card.data JSON when present. `exportCardsToApkg()` is the export entry point (unique revlog ids, suspended → queue -1).
- `anki-io.ts` — Import/export Anki "Notes in Plain Text" (`.txt`) format. Tab-separated with `#header` directives; tags and deck come from the file (header or column), `--deck` overrides the deck, and notes naming no deck are refused. `#html` and `notetype` are not read.
- `pressure.ts` — SRS pressure: two axes (review backlog excluding state-New cards, cards added today) with warn/pause thresholds. `dueReviewWhere()` is the one backlog predicate (pressure, `startSession`, overview) and `NEW_CARD_WHERE` the one new-card pool (unsuspended state New, whatever its `due`; pressure's `newAvailable` and session top-ups). `checkPressure()` backs the `check_pressure` tool; `assertCanCreateCard()` gates `createCard` at pause (`inheritFrom` creates and `updateCard` are never gated). New cards are an optional pool, never backlog; the cards-added-today axis uses the local calendar day (days.ts). Splits are excluded from intake via the `Card.inheritedFrom` column, set by `createCard` when `inheritFrom` is passed; imported cards created today do count. `clearance` covers the flashcards axis only — reviewing cannot lower intake, only the next day resets it. Batch writers that check pressure once up front pass `skipPressureGate` so an import is refused atomically rather than aborting half-applied (see `importCards`). Two entry points by cost: the internal `checkPressureCore()` is two counts flat and backs the create gate, while `checkPressure()` adds `newAvailable` and the per-deck breakdown (`listDeckStats`), 7 queries in all. Keep the gate on the core — it runs on every fresh card and reads none of the extras.
- `leeches.ts` — Leech enforcement, in the same spirit as the pressure gate: `getNextCard` stamps `Card.leechFlaggedAt` on a served card with `LEECH_LAPSES` (5) or more lapses and refuses to serve another until the flag is answered — `update_card` (clears the flag and resets lapses to 0), a split via `create_card` with `inheritFrom` plus `delete_card`, a plain `delete_card`, or `deferLeech` behind the `resolve_leech` tool. A deferral records `Card.leechDeferredLapses` and flags again at the next failure. Suspended cards are never flagged, and `inheritFrom` copies neither the flag nor the lapse count off a flagged parent.
- `card-notes.ts` — Card notes: what the developer noted about a card mid-study (Omvida's Ctrl+N) to handle later in one fix session, free markdown, one per card (`CardNote`, cascade-deleted with the card). A table rather than a Card column, so a note never moves `Card.updatedAt`. `setCardNote` (empty body deletes), `listCardNotes`, `resolveCardNote` (the `resolve_card_note` tool, after the fix). Nothing here edits the card itself. The app server's `stamp` counts notes too, and `sessions` (`src/core/recent-sessions.ts`) lists recent sessions with the cards each lapsed and noted, by time window, since reviews carry no session id.
- `analytics-service.ts` — `getFullStats()` aggregates streak, retention, maturity, lapses in parallel. The streak counts consecutive local days with at least one review (`Review.reviewedAt`), not session starts.
- `grading.ts` — Suggested ratings for typed answers, from `claude -p` (Sonnet, `--json-schema` structured output, ~3s). Claude runs bare: `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, so it judges against the card back alone and loads nothing. The rubric in `GRADE_SYSTEM_PROMPT` is /study's and is **fixed**: the ratings produce the true-retention number that tunes difficulty, so the rubric must not move with it. It also flags card quality issues (/study's list). It only suggests: nothing here writes, and `submitReview` takes whatever rating the developer chose. The app server's `Grader` keeps one spare `claude` booted while a session is open (stream-json input, since plain `-p` gives up on stdin after 3s; the spare holds nothing of a card, so it carries over) and grades each answer on a fresh process; a newer `grade` ends the one still running, claiming its process on arrival so requests keep their order. `nextCard` ends the last card's grade and makes sure a spare is up, `endSession` ends both. The process starter is injected for tests.
- `db-dump.ts` — Portable SQL dump/restore behind `db:dump`/`db:restore`.
- `days.ts`, `version.ts` (`PACKAGE_VERSION` from package.json, reported by the CLI and the MCP server), `types.ts` (shared types, `CARD_STATE_NAMES`, `parseTags()`/`serializeTags()`).

**MCP server** exposes 27 tools. `src/mcp/server.ts` exports `createServer()` and starts only when run directly, exiting 1 when start-up fails. Tool arguments are validated by `McpServer` against each tool's Zod `inputSchema`; every tool error is a thrown error, which the SDK turns into an `isError` result. Its tests (`__tests__/mcp/server.test.ts`) drive the real tools through the SDK's `InMemoryTransport`. **`.txt` import/export is CLI-only** — `import_anki_txt` and `export_anki_txt` are intentionally absent from the MCP server. `.apkg` import/export is also CLI-only (file I/O); the MCP server handles in-memory card operations only.

**Skills** (in `~/.claude/skills/`):
- `/study` — Interactive review sessions. Claude evaluates answers and rates them.
- `/study-flashcard` — Create SRS flashcards directly: suggests a few ready fronts, the developer picks, they are created after semantic duplicate detection.

## Key Design Decisions

**Anti-overload:** Never auto-generate cards. Drafts require explicit approval. Default 2-3 cards per creation session. Practice-first mode prioritizes exercises over flashcards.

**Internalized cards:** Stay active at lower review frequency (FSRS stability handles natural spacing). Never removed; "internalized" is derived by `cardMaturity()` (Review state, interval ≥ `MATURE_INTERVAL_DAYS`).

**Duplicate detection:** Two-stage — Jaccard word-overlap on fronts (fast, always on) then cosine similarity on front+back embeddings (requires `initEmbeddings()` first load). Thresholds (`embeddings.ts`): `createCard` warns at Jaccard ≥ `JACCARD_WARN` (0.65) and calls it a duplicate at ≥ `JACCARD_DUPLICATE` (0.85); `findSimilar` reports from `JACCARD_SIMILAR` (0.50); cosine matches at ≥ `COSINE_MATCH` (0.45). Pass front and back to `findSimilar` so its embedding compares like with like.

**Anki interop:** `.apkg` import handles both legacy `collection.anki2` and modern `collection.anki21b` (zstd-compressed). Cards with native FSRS data in `card.data` JSON are used directly; SM-2 cards are converted via `convertSM2toFSRS()`.

## Lint Rules to Know

- `strict-boolean-expressions` (warn): No implicit truthy checks on strings/numbers. Use explicit `!== ""`, `!== 0`, `!= null`.
- `no-floating-promises` (error): Must `await`, `.catch()`, or `void` all promises.
- `consistent-type-imports` (error): Use `import type { Foo }` or `import { type Foo }`.
- `eqeqeq` (error, null-exempt): Use `===`/`!==` except for `== null` / `!= null`.

## Test-First Workflow

Write tests before implementation. Tests use a fresh temp SQLite DB per suite (see `__tests__/setup.ts`). Test files mostly mirror source structure: `__tests__/core/scheduler.test.ts` tests `src/core/scheduler.ts`; cross-cutting behaviour gets its own file (`tombstones.test.ts`).

## Debugging (omp)

TypeScript LSP comes from the `typescript-language-server` devDependency (omp finds it in `node_modules/.bin`). `.omp/dap.json` points omp's `js-debug-adapter` at `tsx` (`--import tsx`), so `debug launch` on a `.ts` entry point (e.g. `src/cli/index.ts`) stops on entry with source-mapped breakpoints; it needs vscode-js-debug's `dapDebugServer.js` at `~/.local/opt/js-debug/src/` (or `JS_DEBUG_DAP_SERVER`).
