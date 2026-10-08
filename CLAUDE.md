# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Verify

```bash
npm test                          # Run all tests (vitest)
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
npm run dev:cli -- <command>       # CLI: init, study, stats, calibration, overview, decks, cards, topics, import, export, embeddings
npm run dev:mcp                    # MCP server (stdio transport, configured in .claude/settings.json)
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

**The app server** (`src/app/`) is the Omvida desktop app's connection (`~/Code/omvida`): newline-delimited JSON over stdio, `{id, method, params}` in and `{id, result|error}` out, plus a `{"ready": true}` line at start. Not MCP, which would make a QML client implement the handshake and result envelopes for nothing it needs; not the CLI per call, because each start costs about a second. `handlers.ts` is the method table (the /study loop's tools reshaped for a GUI) and differs from the MCP tools in two deliberate ways: `startSession` derives `maxNewCards` from the pressure verdict itself (ok → default, warn/pause → 0, /study's Phase 2 table), and `nextCard` returns a leech block as data (`{blocked: {card, lapses}}`) instead of throwing, since a GUI needs the card to show the ways out. `nextCard` also carries `schedules`, what each rating would schedule (`previewSchedules` in session-service, the same FSRS step and intra-day rule as `submitReview`), for the app's rating keys. `overview.ts` builds the progress picture (pressure, calibration, streak, maturity, the last seven local days of reviews, pending review cards) that both the app and `master overview` (the bar widget's source) print; it passes the pressure and calibration verdicts through whole, never recomputing them. Requests run concurrently, so a grade never holds up a page of cards.

**Maturity is derived, never stored.** The `Card.maturity` column still exists in `schema.prisma` but nothing reads or writes it. It was only set at creation and never updated on review, so it reported cards with 38 reps and 2229 days of stability as `new`; `getMaturityReport` then silently dropped any card whose value wasn't one of the four `CardMaturity` strings via `if (m in counts)`, making the buckets not sum to the card count. Call `cardMaturity(card)` at the point of display. The column can be dropped by removing it from `schema.prisma` and running `npx prisma db push`.

**Core modules** (`src/core/`):
- `scheduler.ts` — ts-fsrs wrapper. Pure functions, no DB. `reviewCard()` applies a rating, `getRetrievability()` returns recall probability, `cardMaturity()` derives new/learning/familiar/internalized from `state` + `interval` (mature at `MATURE_INTERVAL_DAYS`, Anki's 21-day convention). Uses `Grade` type from ts-fsrs (not `Rating` — `Grade` excludes the `Manual` variant).
- `card-service.ts` — Card CRUD, duplicate detection (Jaccard + semantic embeddings), `backfillEmbeddings()`, `findSimilar()`, `getDueCards()`.
- `session-service.ts` — Study session lifecycle. An open session's queue and position are saved in `StudySession.queueState` (JSON) on every change and cached per process, so a session survives a restart of the MCP server or the app server and any process can resume it; one process drives a session at a time. `endSession` and an exhausted queue clear it. Anti-overload: caps new cards at 5, review at 15, reduces new cards when reviews > 10. **`endTime` means "the session was ended" — `submitReview` does not touch it**, so a null `endTime` is a session that was never closed rather than one that is merely idle. Close with `endSession()` (idempotent; the `end_session` MCP tool). `startSession()` first discards sessions that reviewed nothing, since those carry no information; sessions that did review cards are left open rather than back-stamped, because inventing an end time would invent a duration.
- `embeddings.ts` — Two-stage similarity: `jaccardSimilarity()` (always available) + `cosineSimilarity()` on 384-dim vectors from `@huggingface/transformers` (lazy-loaded, ~30s first call). `findSimilarCards()` accepts optional `SemanticOptions` for the embedding stage.
- `anki-apkg.ts` — Import/export `.apkg` files with full scheduling. Handles `collection.anki21b` (zstd-compressed SQLite) via `fzstd`. Converts between Anki SM-2 fields and FSRS, and reads native FSRS data from card.data JSON when present.
- `anki-io.ts` — Import/export Anki "Notes in Plain Text" (`.txt`) format. Tab-separated with `#header` directives.
- `pressure.ts` — SRS pressure: two axes (review backlog excluding state-New cards, cards added today) with warn/pause thresholds. `checkPressure()` backs the `check_pressure` tool; `assertCanCreateCard()` gates `createCard` at pause (`inheritFrom` creates and `updateCard` are never gated). New cards are an optional pool, never backlog; the cards-added-today axis uses the local calendar day, unlike the UTC streak convention in analytics-service. Splits are excluded from intake via the `Card.inheritedFrom` column, set by `createCard` when `inheritFrom` is passed. `clearance` covers the flashcards axis only — reviewing cannot lower intake, only the next day resets it. Batch writers that check pressure once up front pass `skipPressureGate` so an import is refused atomically rather than aborting half-applied (see `importTxtNotes`). Two entry points by cost: the internal `checkPressureCore()` is two counts flat and backs the create gate, while `checkPressure()` adds `newAvailable` and the per-deck breakdown at 4 + 5N queries in deck count. Keep the gate on the core — it runs on every fresh card and reads none of the extras.
- `calibration.ts` — Study calibration: true retention over a 30-day window (Anki's convention — `elapsedDays >= 1`, first review per card per **local** calendar day, rated >= 3) against an 80-90% band, with `low-signal` below 50 eligible reviews or above an 80% Good share, and `marginal` within 2 points of a band edge. Backs the `check_calibration` tool and the `calibration` CLI subcommand, which prints the report as JSON in snake_case — that shape is a wire format the study repo parses, so do not rename its fields. Reviews are windowed in SQL, which is safe because every DateTime column is ISO text: `src/db/normalize.ts` converts the epoch-ms integers older Prisma wrote, on every start of the CLI, the MCP server and the app server.
- `leeches.ts` — Leech enforcement, in the same spirit as the pressure gate: `getNextCard` stamps `Card.leechFlaggedAt` on a served card with `LEECH_LAPSES` (5) or more lapses and refuses to serve another until the flag is answered — `update_card` (clears the flag and resets lapses to 0), a split via `create_card` with `inheritFrom` plus `delete_card`, a plain `delete_card`, or `deferLeech` behind the `resolve_leech` tool. A deferral records `Card.leechDeferredLapses` and flags again at the next failure. Suspended cards are never flagged, and `inheritFrom` copies neither the flag nor the lapse count off a flagged parent.
- `analytics-service.ts` — `getFullStats()` aggregates streak, retention, maturity, lapses in parallel.
- `grading.ts` — Suggested ratings for typed answers, from `claude -p` (Sonnet, `--json-schema` structured output, ~3s). Claude runs bare: `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, so it judges against the card back alone and loads nothing. The rubric in `GRADE_SYSTEM_PROMPT` is /study's and is **fixed**: the ratings produce the true-retention number that tunes difficulty, so the rubric must not move with it. It also flags card quality issues (/study's list). It only suggests: nothing here writes, and `submitReview` takes whatever rating the developer chose. The runner is injected for tests.
- `types.ts` — Shared types, `parseTags()`/`serializeTags()` utilities.

**MCP server** exposes 25 tools. Tool arguments are validated by `McpServer` against each tool's Zod `inputSchema`; handler throws auto-convert to `isError` results. **`.txt` import/export is CLI-only** — `import_anki_txt` and `export_anki_txt` are intentionally absent from the MCP server. `.apkg` import/export is also CLI-only (file I/O); the MCP server handles in-memory card operations only.

**Skills** (in `~/.claude/skills/`):
- `/study` — Interactive review sessions. Claude evaluates answers and rates them.
- `/study-flashcard` — Create SRS flashcards directly: suggests a few ready fronts, the developer picks, they are created after semantic duplicate detection.

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
