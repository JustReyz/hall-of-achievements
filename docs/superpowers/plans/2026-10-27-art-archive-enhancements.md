# Art archive enhancements implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Track progress with the checkboxes. Re-read AGENTS.md before execution.

**Goal:** Add the selected browsing, organization, import, export, and recovery features to the private art archive.

**Architecture:** Extend the existing gallery request owner, modal, authenticated API routes, storage adapters, image pipeline, and database migration entry point. Deliver one complete feature phase at a time. Share media-lifecycle operations only where multiple routes must enforce the same invariant.

**Tech stack:** Existing Next.js 15, React 19, TypeScript, Drizzle, PostgreSQL, Sharp, Vitest, and PGlite. Use browser pointer events, Fullscreen API, and Canvas where appropriate.

**Spec:** [Selected feature ideas](../../FEATURE-IDEAS.md). The completed [date-filter feature](../../FEATURE-PLAN.md) is a compatibility requirement.

**Baseline:** Source reviewed at `a579e6c` on 2026-10-27. This is a proposed execution plan. No feature code, migrations, application tests, or deployment were performed while writing it.

## Global constraints

- All artwork, metadata, image probes, collection operations, and exports require the existing owner session. Mutations retain CSRF protection and private responses retain no-store headers.
- Keep search, applied completion dates, pagination, retry behavior, and request-generation guards working throughout the phases.
- Do not download originals during ordinary browsing, health checks, or contact sheet generation. Request display or thumbnail assets explicitly.
- Retain current image validation, 10 MiB original limit, 20-megapixel limit, 70% storage ceiling, three active upload intents, 12 MiB reservation per intent, and 15-minute intent expiry. Import these limits from their existing owners rather than duplicating them.
- Keep private images and signed URLs out of logs, local storage, service-worker caches, and new third-party services. Revoke temporary object URLs and release decoded images.
- Use labeled native controls, visible focus, keyboard access, and button targets of at least 44 CSS pixels. Respect reduced-motion preferences for viewer transitions.
- Add no dependency, provider, scheduler, or public sharing system. Use the installed packages and native platform APIs.
- Trash has no automatic expiry. Only an explicit permanent-delete action authorizes object removal. Trashed bytes still count toward quota.
- Process gallery #8 remains optional. Its schema and UI are absent until that phase is separately scheduled.

## Scope and delivery order

The ideas span independent areas, so each phase below is a separate deliverable with its own proof and review. Keep this document as the single execution plan requested by the owner.

| Phase | Ideas | Result | Relative scope |
| --- | --- | --- | --- |
| 0 | Prerequisites | Reproduce upload retry and permanent-cleanup hazards in hermetic tests. | Small |
| 1 | #4, #13 | Fullscreen viewer with zoom, pan, navigation, and three backgrounds. | Medium |
| 2 | #6 | Clickable exact-tag browsing combined with search and dates. | Medium |
| 3 | #16 | Persisted thumbnail framing without image changes. | Medium |
| 4 | #7 | Download a contact sheet from selected artworks. | Medium |
| 5 | #10 | Manual archive health checks that distinguish missing objects from provider failures. | Medium |
| 6 | #9 | Sequential batch upload with safe per-file retry. | Large |
| 7 | #12 | Recoverable trash and retryable permanent cleanup. | Large |
| 8 | #14 | Ordered collections with safe concurrent edits. | Large |
| 9 | #8, optional | Additional process images attached to a completed artwork. | Large, deferred |

Phase 0 investigates the dangerous boundaries first. Phases 1 and 2 need no database change. Phases 6 and 7 cannot pass review without closing the reproduced lifecycle hazards.

## Current behavior and ownership

| Concern | Existing owner | Consequence for this plan |
| --- | --- | --- |
| Applied filters and pagination | `src/app/page.tsx`, `src/app/api/achievements/route.ts` | Extend these owners. Do not add a second competing gallery fetch loop. |
| Modal focus and Escape | `src/components/gallery/AchievementDetailModal.tsx` | Add viewer mode within its existing dialog so two Escape listeners cannot close nested dialogs. |
| Image processing | `src/lib/image/processor.ts` | Display images fit inside 1600 pixels. Thumbnails fit inside 400 pixels. Both preserve the whole image. Cards apply the 4:3 crop in CSS. |
| Asset access | `src/app/api/achievements/[id]/assets/route.ts` | Signed links last 60 seconds. Omitting `type` also issues an original link. Viewer and export must specify display assets. |
| Upload flow | `AddAchievementModal.tsx`, intent and finalize routes | Reuse intent, direct upload, and finalize for every batch item. Finalization replay is currently safe only after the consumed record commits. |
| Permanent deletion | Item DELETE route and `src/lib/storage/maintenance.ts` | Both currently discard cleanup records after storage-delete failures. Fix this before promising recoverable permanent cleanup. |
| Quota | `src/lib/storage/quota.ts` | All main asset rows are counted, regardless of achievement state. Preserve that behavior for Trash. |
| Database upgrades | `schema.ts`, `db/index.ts`, `db/migrate.ts` | Existing CREATE TABLE statements do not add columns to deployed tables. There are separate PGlite and pooled PostgreSQL initialization paths. |
| Backup | `src/lib/operations/export.ts`, `restore.ts` | Writer currently emits version 1. Restore explicitly maps fields. Every persisted addition needs restore mapping and compatibility tests. |

## Phase 0: Establish the lifecycle checks

**Files to inspect:** `src/app/api/uploads/[id]/finalize/route.ts`, `src/app/api/achievements/[id]/route.ts`, `src/lib/storage/maintenance.ts`, `src/lib/db/index.ts`, `tests/integration/uploads.test.ts`, `tests/integration/achievements-crud.test.ts`, and `tests/integration/export-restore.test.ts`.

- [x] Run `npm ci` if dependencies are absent. Preserve the lockfile. (Skipped: `node_modules` was present and the full suite ran; lockfile unchanged.)
- [x] Run `npm test` and `npm run typecheck` once. Record actual results instead of copying the earlier date-filter results. (`npm test`: 28 files, 286 tests passed, 315.11s. `npm run typecheck`: passed with no output.)
- [x] In a test using the memory adapter, make one permanent object deletion throw. Confirm that the current code removes its database cleanup record. Keep the corrected expectation as a regression test in Phase 7. (Temporary local harness: DELETE returned 200 with `databaseRowStillPresent: false` and `objectStillPresent: true`; maintenance reported `cleaned: 1` while the object remained.)
- [x] Send two concurrent first finalizations for one intent and simulate a lost success response. Record duplicate, replay, and quarantine behavior. Keep these cases in Phase 6's suite. (Temporary local harness: both calls returned 200, created 2 achievements and 2 assets for one intent; intent ended `consumed`, replay returned the second achievement, quarantine was removed.)
- [x] Confirm the two database initialization paths and current backup field mappings. Use synthetic records only. (`CREATE TABLE IF NOT EXISTS` left an existing table without a hypothetical new column. Query-only initialization created all nine tables. Version 1 round-trip preserved achievement metadata, asset keys/dimensions/checksum, and five binary objects. Unknown version 2 was rejected before mutation; an unknown field was dropped.)

Do not leave failing tests on a shared branch. Land each regression with its feature fix, or keep the reproduction local until that phase begins. No production probes or destructive operations are required.

## Phase 1: Fullscreen viewing and backgrounds

**Modify:** `src/components/gallery/AchievementDetailModal.tsx`, `src/app/page.tsx`, `src/app/globals.css`.

**Create:** `src/components/gallery/ArtworkViewer.tsx`, `src/lib/image/viewer-transform.ts`, `tests/unit/viewer-transform.test.ts`.

`ArtworkViewer` renders media and controls inside the existing detail dialog. It does not create another modal or focus trap. The detail modal remains the owner of close and focus restoration.

```ts
type ViewerBackground = 'light' | 'gray' | 'black';
type ViewTransform = { zoom: number; x: number; y: number };
type ViewerSize = { width: number; height: number };

// Proposed pure helper in viewer-transform.ts.
export function clampViewerTransform(
	value: ViewTransform, viewport: ViewerSize, fittedImage: ViewerSize
): ViewTransform;
```

- [x] Implement and unit-test fit-relative zoom from 1 to 4. Bound pan to the scaled image edges. Reset transform on artwork change or Fit action.
- [x] Add Zoom in, Zoom out, Fit, Previous, Next, Close, and light/gray/black background controls. Use fixed colors `#ffffff`, `#808080`, and `#000000`. Keep the chosen background in page-session state without storing art or adding a preference database.
- [x] Support pointer drag with pointer capture. Release capture on pointer up or cancellation. Restrict touch-action suppression to the media area.
- [x] Use a viewport-filling mode as the reliable fullscreen experience. Call native `requestFullscreen()` only from its button when supported. If denied or unsupported, keep the viewport viewer working. Escape exits viewer mode before closing details, with one keyboard owner. Native `fullscreenchange` must also update the viewer's state.
- [x] Arrow keys navigate when focus is outside inputs, range sliders, and other editable controls. Keep all actions available as labeled buttons.
- [x] Fetch only `type=display`. On an expired image URL, request a fresh display URL once, then show an error and explicit retry. Ignore stale image responses after navigation or logout.
- [x] Let the page own selected achievement ID and active order. At the last loaded item, await the existing next-page request under the same filter snapshot. Select its first new record only if the request and navigation generation remain current. Prevent duplicate next-page requests and preserve selection on failure.
- [x] Disable Previous at the first item. Disable Next only when no more items exist. Filter changes close the viewer and invalidate pending navigation. Metadata edits that remove the selected item from the result set also close the viewer after refresh.

Implement the pan bounds with the fitted dimensions rather than original EXIF dimensions:

```ts
const zoom = Math.min(4, Math.max(1, value.zoom));
const maxX = Math.max(0, (fittedImage.width * zoom - viewport.width) / 2);
const maxY = Math.max(0, (fittedImage.height * zoom - viewport.height) / 2);
return { zoom, x: Math.max(-maxX, Math.min(maxX, value.x)), y: Math.max(-maxY, Math.min(maxY, value.y)) };
```

**Proof:** Test zero overflow at zoom 1, clamped zoom, both pan limits, and resize re-clamping. In a browser, verify keyboard focus, one Escape action, page-boundary navigation, delayed responses, mobile fallback, transparent images on all three backgrounds, and no original request. Zoom magnifies the existing 1600-pixel derivative. Original-resolution inspection remains the existing explicit download action.

## Phase 2: Exact-tag browsing

**Modify:** `src/app/page.tsx`, `src/app/api/achievements/route.ts`, `src/lib/validation/achievement.ts`, `src/components/gallery/types.ts`.

**Create:** `src/app/api/tags/route.ts`, `src/components/gallery/TagBrowser.tsx`, `src/lib/gallery/query.ts`, `tests/integration/tag-browser.test.ts`.

- [x] Move the applied `GalleryFilters` type into gallery types and add `tag: string`. Update `EMPTY_FILTERS`, apply, clear, first-page, retry, append, and mutation refresh call sites together. Clearing dates still preserves search and tag. An All tags control clears only tag.
- [x] Normalize a selected tag using existing tag rules, including lowercase and the 24-character limit. Reject invalid inputs with the existing validation error response.
- [x] Extract the shared ready-state, search, and date predicates into `buildGalleryConditions(filters)` in `query.ts`. The gallery and tag routes consume the same validated scope. Keep cursor logic in the gallery route.
- [x] Add an authenticated `GET /api/tags` returning `{ tags: string[] }`, sorted and distinct across matching ready achievements. Accept `q`, `from`, and `to`; ignore the selected tag so alternatives remain discoverable. After Phase 8, also honor the collection scope. Do not derive available tags from only the current 24 loaded cards.
- [x] Apply exact array membership when the gallery has a selected tag. Do not put the tag into `q`, which also searches titles and notes.

```ts
conditions.push(sql`${achievements.tags} @> ${JSON.stringify([filters.tag])}::jsonb`);
```

- [x] Render labeled tag buttons and All tags. Set `aria-pressed` on the active choice. Show loading, unavailable-with-retry, and no-tags states. Retain a selected tag even if it is absent from the latest facet list. Ignore stale tag-list responses.
- [x] Requery tags after successful create, edit, trash, or restore operations. Close the viewer and clear contact sheet selection when scope changes.

**Proof:** Seed tags `oil` and `oil-pastel`, plus a title-only occurrence of `oil`. Exact tag selection returns only the actual `oil` member. Test search/date intersection, tags found beyond page one, no tags from pending/deleting records, and unauthenticated denial. After Phase 7, add trashed exclusion to the shared predicate once.

## Phase 3: Thumbnail framing and additive migration support

**Modify:** `src/lib/db/schema.ts`, `src/lib/db/index.ts`, item PATCH/GET and gallery GET projections, `src/components/gallery/types.ts`, `AchievementDetailModal.tsx`, `GalleryCard.tsx`, export and restore operations.

**Create:** `src/lib/db/schema-upgrades.ts`, `tests/integration/thumbnail-framing.test.ts`, `tests/integration/archive-migrations.test.ts`.

- [x] Add `thumbnailPositionX` and `thumbnailPositionY` as finite real values between 0 and 1, defaulting to 0.5. Add database range constraints and matching API validation. Reject strings, null, infinity, and out-of-range values rather than silently clamping writes.
- [x] Put idempotent upgrade SQL in `applyArchiveSchemaUpgrades(client)` in `schema-upgrades.ts`. Call it from both existing initialization branches. The existing locked `db:migrate` entry point must execute these upgrades and propagate failure. Add only each phase's required SQL when implementing that phase.

```sql
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS thumbnail_position_x REAL NOT NULL DEFAULT 0.5;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS thumbnail_position_y REAL NOT NULL DEFAULT 0.5;
```

Add the two range constraints using named, idempotently installed constraints in the same upgrade. Keep Drizzle declarations and runtime SQL consistent.

- [x] Include both values in gallery and item responses. Reuse the detail PATCH endpoint and its authenticated metadata-save path.
- [x] Add horizontal and vertical sliders with a 4:3 preview and Center action. A keyboard user can change either axis and save. Preserve draft framing when saving fails.
- [x] Apply framing only to the gallery card. Keep the full display image and downloadable original unchanged.

```tsx
objectPosition: `${achievement.thumbnailPositionX * 100}% ${achievement.thumbnailPositionY * 100}%`
```

- [x] Add the fields to backup and restore. Write archive version 2 and accept version 1 with centered defaults. Newer unknown archive versions must fail before changing storage or the database.
- [x] Test an existing pre-feature database upgrade, repeat execution, fresh PGlite initialization, and the pooled migration path. Do not assume `CREATE TABLE IF NOT EXISTS` upgrades existing rows.

**Proof:** A saved non-center value survives refresh and backup/restore. Original and derivative checksums do not change. Range validation is enforced at both API and database boundaries. Test the pure condition `typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1`, including NaN before JSON serialization. Existing cards default to centered framing.

## Phase 4: Contact sheet export

**Modify:** `src/app/page.tsx`, `GalleryGrid.tsx`, `GalleryCard.tsx`, `src/app/api/achievements/[id]/assets/route.ts`.

**Create:** `src/components/gallery/ContactSheetExport.tsx`, `src/lib/image/contact-sheet.ts`, `tests/unit/contact-sheet.test.ts`, `tests/integration/display-asset-bytes.test.ts`.

- [x] Add an explicit selection mode with native checkboxes outside the card's open-artwork button. Do not nest interactive controls. Keep selection as ordered achievement IDs in page memory and cap it at 24.
- [x] Preserve selection when appending a page. Clear it when filters, collection, session, or archive contents change. Explain that selecting all means loaded artworks, never unseen pages. (Collection scope arrives in Phase 8.)
- [x] Extend the existing asset route with `type=display&delivery=inline`. This authenticated mode loads the server-owned sanitized display key and returns image bytes with `Content-Type: image/webp`, private no-store headers, and `X-Content-Type-Options: nosniff`. Reject inline original requests and client-supplied URLs or keys.
- [x] Enforce a 4 MiB display-response bound. Refuse an oversized or invalid derivative with a visible export error rather than routing an original through the function. This stays below Vercel's documented 4.5 MB function payload limit.
- [x] Use that same-origin bytes mode for canvas input so canvas export does not depend on storage-provider CORS. Existing signed-link browsing remains unchanged.
- [x] Implement `getContactSheetLayout(count)` in `contact-sheet.ts`, accepting 1 through 24. Use up to four columns, 512-by-416 cells, 16-pixel gaps, and 24-pixel outer margins. Reserve 384 pixels for the image and 32 for a plain-text caption. Reject a canvas edge above 4096 pixels.

```ts
const columns = Math.min(4, count);
const rows = Math.ceil(count / columns);
return {
	width: 48 + columns * 512 + (columns - 1) * 16,
	height: 48 + rows * 416 + (rows - 1) * 16,
	columns, rows,
};
```

- [x] Fill the canvas white. Draw complete display images with contain sizing, in selection order, without card framing. Truncate long titles to fit with a visible ellipsis using canvas text measurement. Download `artwork-contact-sheet.png` through `canvas.toBlob`.
- [x] Fetch and decode one image at a time. Release each bitmap and temporary URL. Support Cancel, abort on logout, and abandon stale work on scope changes. On any missing or failed image, name the affected artwork and stop. Do not silently export an incomplete sheet.

**Proof:** Unit-test layout at 1, 4, and 24 selections and rejection at 0 and 25. Browser-test a real downloaded PNG, its dimensions, transparency against white, long titles, selection order, failure, cancellation, and no original downloads. The 24-image sheet must be 2144 by 2624 pixels.

## Phase 5: Manual archive health check

**Modify:** `src/lib/storage/adapter.ts`, `memory.ts`, `postgres.ts`, `supabase.ts`, `src/app/page.tsx`, and the detail modal's restore entry point.

**Create:** `src/lib/storage/health.ts`, `src/app/api/archive/health/route.ts`, `src/components/gallery/ArchiveHealthPanel.tsx`, `tests/unit/storage-health.test.ts`, `tests/integration/archive-health.test.ts`.

```ts
// New adapter method, implemented by all three existing adapters.
getObjectMetadata(key: string): Promise<StorageObjectMetadata>;

type ObjectHealth = 'present' | 'missing' | 'unknown';
type AchievementHealth = {
	id: string;
	original: ObjectHealth;
	display: ObjectHealth;
	thumbnail: ObjectHealth;
	checkedAt: string;
};
```

- [x] Implement metadata-only object inspection using each provider's metadata or HEAD operation, SQL metadata lookup, or the memory map. No original-byte reads or arbitrary URL fetches.
- [x] Only a typed `StorageNotFoundError` means missing. Authentication errors, throttling, transport failures, and timeouts mean unknown. A missing asset record means missing linkage, shown distinctly in the panel.
- [x] Add authenticated, CSRF-protected `POST /api/archive/health` with body `{ ids: string[] }`. Accept 1 through 8 unique UUIDs, load their non-trashed ready records server-side, and inspect only their database-owned keys. Return per-artwork results without storage keys or signed URLs.
- [x] Bound provider-probe concurrency to three and use request timeouts. A single failed probe produces unknown for that object rather than failing the whole batch.
- [x] Start only from Check archive. Page through the current archive scope, submit batches of eight IDs, show progress, and support cancellation. Guard progress with the current scope generation. Do not scan on login, a timer, or every render.
- [x] Link a missing-image result to the existing Restore artwork picker by opening details with a restore request. Keep the distinction between metadata restoration and file restoration clear. A health check never deletes, repairs, or replaces automatically.

**Proof:** A missing original with intact derivatives, a missing thumbnail only, absent linkage, and a provider outage produce distinct results. Assert the adapter's `getObject` is never called during probes. Test authentication, malformed/oversized ID batches, server-derived keys, cancellation, and progress over more than eight artworks.

## Phase 6: Batch uploads with safe retry

**Modify:** `AddAchievementModal.tsx`, `src/app/api/uploads/[id]/finalize/route.ts`, schema/upgrades, `src/lib/storage/maintenance.ts`, `src/lib/storage/quota.ts`, backup asset-field mapping, and existing upload/quota tests.

**Create:** `src/components/gallery/BatchUploadList.tsx`, `src/lib/uploads/finalize.ts`, `src/lib/uploads/upload-item.ts`, `tests/integration/batch-upload.test.ts`.

Keep a single-file selection working through the same UI and pipeline. Start with at most 20 selected files and one active upload. This naturally stays below the existing concurrency cap while giving each file separate details and results.

```ts
type UploadStage = 'editing' | 'queued' | 'uploading' | 'finalizing' | 'unknown' | 'failed' | 'succeeded';
type UploadQueueItem = {
	id: string;
	file: File;
	title: string;
	completionDate: string;
	notes: string;
	tags: string[];
	stage: UploadStage;
	intentId: string | null;
	achievementId: string | null;
	error: string | null;
};
```

- [x] First close the finalization replay gap. Move the route's operation into `finalizeUpload` in `src/lib/uploads/finalize.ts`, retaining authentication and body validation at the route boundary.
- [x] Durably bind each creation intent to one pending achievement before writing permanent objects. Serialize work for the same intent with a PostgreSQL row lock and re-read its status under that lock. Lock the parent as well for reattachment. A concurrent first call must reuse the bound record, not allocate another achievement.
- [x] Retain quarantine until the asset metadata, ready state, and consumed intent commit. Permanent writes must be retryable for the same intent and paths. Retain durable references to any partial writes. Extend expired-intent maintenance to clean a bound pending achievement and its partial objects before discarding their references.
- [x] Store an intent's planned permanent keys in `uploadIntents.permanentKeys`, a JSONB string array, before the first permanent write. Use intent-specific immutable paths for replacement objects. Add `assets.retiredObjects`, a JSONB array of `{ keys: string[]; accountedBytes: number }`, for previous versions awaiting cleanup. Both additions default to empty arrays and require the shared upgrade path. Atomically move old keys and their conservative byte allowance into retiredObjects when replacing the active asset. Remove an entry only after all its keys are deleted.
- [x] Include retired object bytes in quota. Keep failed quarantine cleanup durably tracked and counted as well. Verify the actual staged-byte envelope against the existing reservation before allowing another item. Reject derivatives exceeding `MAX_DERIVATIVE_BOUND_BYTES` before storage writes. Do not fix an accounting failure by raising the provider ceiling or releasing a reservation early.
- [x] A consumed intent returns the same achievement and asset on replay. Validate the linked achievement from the persisted intent, never a caller-supplied fallback. After Phase 7, a replay or attachment must not expose or revive a trashed/deleting item.
- [x] Keep replacement behavior covered by existing restore tests. A failed replacement must not erase the last recoverable file or lose cleanup references. If replacement needs versioned keys, keep the old asset record until the new transaction commits and retain any failed old-key cleanup durably. Do not generalize this into a background job framework.
- [x] Export only active artwork keys and clear ephemeral retiredObjects in restored asset records. Warn about incomplete cleanup but do not restore obsolete versions as active images. Internal intent and cleanup fields are not new user-facing archive content and do not require a new archive version.
- [x] Test the tradeoff explicitly: row-lock serialization can occupy a database connection during bounded storage work. Keep uploads sequential, bound storage requests, and measure the focused upload path before increasing concurrency.
- [x] Put the existing intent/PUT/finalize client sequence into `upload-item.ts`. Retain the intent and last confirmed stage on each row. Validate type, size, title, date, notes, and tags using existing rules. Do not keep signed URLs or artwork bytes in persistent browser storage.
- [x] A lost finalize response becomes unknown. Retrying sends finalize again for the same intent. If quarantine is confirmed absent and the intent remains usable, retry the upload stage. Create a new intent only after the earlier one is definitively unconsumed and expired or cleaned. Do not restart successful items.
- [x] Pause the queue on quota exhaustion or an unresolved unknown outcome. Preserve metadata and show Retry, Remove pending item, and Close after completion. Closing cannot pretend to cancel a finalization already accepted by the server.
- [x] Revoke preview URLs as rows are removed or the modal unmounts. Refresh the active gallery and quota after success without replacing filters. Successful items remain identified even if outside the current filters.

**Proof:** Inject a lost success response, concurrent finalize calls, processing failure, partial permanent writes, expired intent, quota rejection, and one failed item among successful items. Assert one achievement per creation intent, successful rows are never re-uploaded, metadata survives retry, originals remain private, and reservation/concurrency limits are unchanged. Keep cleanup records and counted bytes when storage refuses deletion.

## Phase 7: Recoverable trash and reliable permanent deletion

**Modify:** Schema and shared upgrades, gallery query owner, item GET/PATCH/DELETE, asset signing/inline bytes, upload finalization/replay, quota display, `storage/maintenance.ts`, detail deletion copy, page navigation, export and restore.

**Create:** `src/lib/operations/trash.ts`, `src/app/api/trash/route.ts`, `src/app/api/achievements/[id]/restore/route.ts`, `src/app/api/achievements/[id]/purge/route.ts`, `src/components/gallery/TrashPanel.tsx`, `tests/integration/trash.test.ts`, `tests/integration/purge-recovery.test.ts`.

- [ ] Add nullable `achievements.trashedAt` with an additive timestamp upgrade. Retain the existing pending/ready/deleting state values. Centralize normal visibility as ready AND trashedAt IS NULL.
- [ ] Apply that predicate in gallery, exact-tag, item, asset, contact-sheet, health, attachment, and replay paths. After collections exist, apply it there too. Already-issued signed URLs can remain usable for their existing 60-second lifetime.
- [ ] Change normal deletion to Move to Trash and update every caller/test expecting permanent deletion. This is an intentional endpoint behavior change. No image bytes are removed at this step.

| Endpoint | Contract |
| --- | --- |
| `DELETE /api/achievements/[id]` | Idempotently set trashedAt on a ready item. Return `{ trashed: true, id }`. |
| `GET /api/trash` | Private, paginated metadata only. Order by trashedAt then ID descending. No image signing or healthy-gallery cursor reuse. |
| `POST /api/achievements/[id]/restore` | Clear trashedAt only while state remains ready. Restore membership and metadata. Do not claim missing image bytes were recreated. |
| `DELETE /api/achievements/[id]/purge` | Require a trashed item and explicit UI confirmation. Claim deleting state, then perform retryable object cleanup. Return 200 on completion or 202 when cleanup is pending. |

- [ ] In `trash.ts`, implement `moveToTrash`, `restoreFromTrash`, and `purgeAchievement` using row locks or conditional updates. A restore racing a purge cannot clear a claimed deleting state. Missing IDs and invalid transitions use the existing structured error shape.
- [ ] Route both permanent purge and maintenance through one cleanup function. Delete all linked objects first, treating verified absence as success. Only after every object is removed may its asset records and achievement be deleted.
- [ ] Replace the current swallowed-error cleanup. On any provider failure, retain deleting state, asset keys, quota accounting, and a retryable response. A partial successful deletion must converge on retry. Never report fully deleted while bytes or required cleanup references remain.
- [ ] Keep Trash bytes counted by retaining asset rows until cleanup succeeds. Display that Trash does not free space. Do not add an expiry timer, cron, or automatic purge.
- [ ] Include Trash in backups and preserve hidden state on restore. Write archive version 3, accepting versions 1 and 2 with absent trashedAt defaulted to null. Exclude irreversible deleting records from normal export and warn when pending cleanup exists.

The shared cleanup's order must be visible in its implementation:

```ts
await storage.deleteObjects(keys);
// Delete database references only after the awaited deletion succeeds.
await db.delete(achievements).where(eq(achievements.id, id));
```

Both calls operate on an achievement already durably claimed as deleting. Metadata stays present after a thrown storage operation. Keep linked replacement cleanup references from Phase 6 until those keys are also removed.

**Proof:** Trash, restore, repeated actions, default exclusion, asset denial, replay denial, quota retention, and backup round trips. Inject object-delete failure and partial deletion, then retry. Assert cleanup references survive the first failure. Test restore-versus-purge and replacement-versus-trash races. Update old permanent-DELETE tests rather than leaving their previous semantics ambiguous.

## Phase 8: Ordered collections

**Modify:** Schema upgrades, `src/app/page.tsx`, gallery filter types/query scope, export/restore, and trash transitions.

**Create:** `src/lib/operations/collections.ts`, `src/lib/validation/collection.ts`, `src/app/api/collections/route.ts`, `src/app/api/collections/[id]/route.ts`, `src/app/api/collections/[id]/items/route.ts`, `src/components/gallery/CollectionPanel.tsx`, `tests/integration/collections.test.ts`.

- [ ] Add collections with UUID, trimmed name of 1 through 120 characters, revision counter, and timestamps. Add collection_items with collectionId, achievementId, and integer position. Use foreign keys, unique membership, and unique position per collection.
- [ ] Use cascade deletion from a collection to its membership only. Removing a collection or membership must never remove artwork. Retain membership when art enters Trash so restoring it recovers its position. Permanent purge removes that artwork's memberships.
- [ ] Add authenticated collection CRUD and an Items endpoint. Limit the initial collection to 200 members and explain the limit in the editor. Accept at most 200 IDs in a membership/order write. Reject duplicate IDs, non-ready/trashed additions, missing artwork, and invalid revision values.
- [ ] Provide labeled Add to collection, Remove from collection, Move up, and Move down controls. Use these native controls before considering drag behavior.
- [ ] Treat each membership/order update as a complete ordered ID list with its expected revision. Lock the collection, compare revision, validate the list, replace positions transactionally, and increment revision. A stale revision returns HTTP 409 with no partial changes.
- [ ] Collection GET for the editor returns the revision and complete membership identifiers, including labeled entries currently in Trash. Reorder requests must preserve those entries unless the owner explicitly removes them. Existing trashed members may remain in a submitted order; adding a newly trashed member is rejected. The normal collection gallery still hides them.

```ts
type CollectionOrderWrite = { revision: number; achievementIds: string[] };
type CollectionCursor = {
	collectionId: string;
	revision: number;
	position: number;
	achievementId: string;
};
```

- [ ] Paginate curated views by position and ID using their own validated cursor. Include collection ID and revision in that cursor. Reject a cursor from another collection or an old revision. Do not feed a date/UUID gallery cursor into this route.
- [ ] On HTTP 409, reload the collection's first page and explain that its contents changed. Search, exact tag, and date filters narrow collection members without changing their curated order. Global gallery ordering remains date/ID descending.
- [ ] Extend the existing page request owner to choose gallery or collection-items endpoint. Applying a new collection clears its cursor, selection, and viewer navigation generation. Keep `GalleryResponse` pagination fields compatible.
- [ ] Bump affected collection revisions on trash, restore, or permanent purge so in-flight views cannot mix membership visibility. Lock affected collections in consistent UUID order to prevent deadlocks.
- [ ] Export collections and membership metadata with archive version 4. Restore validates all referenced achievement IDs, unique memberships/positions, and revisions before any mutation. Accept prior versions with no collections. Preserve session revocation and integrity verification.

**Proof:** Create/rename/delete a collection, add/remove/reorder members, duplicate and invalid membership rejection, concurrent writes, stale/wrong cursor rejection, filtered pagination, and preserved artwork after collection deletion. Trash and restore return an item to its original position. Round-trip the full archive including trashed memberships and framing.

## Phase 9: Optional process gallery

**Status:** Optional. Stop after Phase 8 unless the owner schedules this feature. Do not add its tables or widen asset behavior in earlier phases.

**Modify when scheduled:** Schema/upgrades, upload intent/finalization ownership, quota, main-artwork lifecycle, health checks, and export/restore.

**Create when scheduled:** `src/lib/operations/process-images.ts`, `src/app/api/achievements/[id]/process-images/route.ts`, `src/app/api/achievements/[id]/process-images/[imageId]/route.ts`, `src/components/gallery/ProcessGallery.tsx`, `tests/integration/process-gallery.test.ts`.

- [ ] Add a separate process_images table with ID, parent achievement ID, position, caption up to 500 characters, and original/display/thumbnail asset metadata. Limit the initial feature to ten process images per artwork. Preserve exactly one main asset in the normal gallery join.
- [ ] Add a validated upload purpose and parent binding to upload intents. Reuse the Phase 6 idempotent operation with distinct keys containing the process-image ID. Process upload must never replace the main-image keys.
- [ ] Apply existing image limits and quota reservations to each image. Include all process bytes and pending cleanup in quota, health, backup, and parent purge. Reject attachments to trashed/deleting parents.
- [ ] Add manual ordering and caption editing. Use the same private display flow and viewer. A process image is not a separate finished achievement and must not inflate gallery counts or appear in exact-tag facets.
- [ ] Preserve process images when the parent is trashed and remove them only through verified permanent cleanup. Failed individual image removal retains its cleanup records and counted bytes.
- [ ] Write archive version 5 with validated process metadata and bytes. Read earlier versions with no process images. Test additional-image retries, order changes, limits, quota exhaustion, parent races, primary-image preservation, and archive round trips.

The additional files and backup version are the material cost of this optional feature. It changes the current one-image model, so it remains separate from the required phases.

## Verification and checkpoints

Run each new focused test before implementation to confirm it detects the missing behavior, then run it after the change. Use existing PGlite, memory storage, auth helpers, and synthetic image fixtures. Do not add tests that only search source code for new variable names.

Useful commands after each phase are:

```powershell
npm test -- tests/integration/gallery-pagination.test.ts tests/integration/achievements-crud.test.ts tests/integration/uploads.test.ts tests/integration/export-restore.test.ts
npm run typecheck
git diff --check
```

Run the phase's new test files as well. After a schema phase, also run migration tests against fresh and populated pre-feature databases. Provider metadata behavior and actual browser canvas downloads require real adapter/browser evidence beyond mocked tests.

- [ ] Review and commit each completed phase separately. Stage only its named files, necessary shared-owner updates, tests, and verification evidence. Keep the application runnable between commits.
- [ ] Update `docs/FEATURE-IDEAS.md` with implemented status only after a phase's automated and browser checks pass.
- [ ] Record commands, actual results, browser viewport, adapter, and skipped checks in a verification section in this document. Keep private art, signed URLs, and credentials out of evidence.
- [ ] At the final required milestone, run `npm test`, `npm run typecheck`, and `npm run build` with safe local configuration. Record configuration blockers separately from code failures.
- [ ] Verify keyboard access and mobile wrapping across the combined flows. Exercise logout while viewer loading, export, upload, and health requests are pending.

## Migration, backup compatibility, and rollback

Before a persisted phase, take a verified private backup and run upgrades against a copy of an existing database. Add columns and tables without rewriting original files or dropping existing data. The migration command must be repeatable and fail visibly.

Backup versions are introduced only with their data changes. Version 2 adds framing, version 3 includes Trash, version 4 adds collections, and optional version 5 adds process images. The current writer emits the latest implemented version. Restore accepts earlier versions with the explicit defaults above, validates all files and relationships, and rejects unknown newer versions before writing anything.

Keep additive schema during rollback. After Trash is used, do not deploy a pre-Trash binary that ignores trashedAt or performs the old permanent DELETE behavior. Roll back UI changes onto a compatibility build that preserves visibility and cleanup invariants. Never drop Trash, collection, or process-image data as an automated rollback step.

Deployments and production migration execution are separate work. This plan does not authorize permanent deletion, public exposure, or executing optional Phase 9.

## Verification log

### Phase 0 (2026-10-27)

- Baseline checkout `a579e6c`; dependencies already installed, lockfile unchanged, `npm ci` skipped.
- `npm test` at baseline: 28 test files passed, 286 tests passed, 315.11s.
- `npm run typecheck` at baseline: passed (`tsc --noEmit`, no diagnostics).
- Temporary local harness (memory adapter, PGlite, synthetic images; removed before commit) reproduced:
  - Permanent DELETE with a throwing `deleteObjects`: HTTP 200, database row deleted, storage object left behind.
  - Maintenance with a throwing `deleteObjects`: `cleaned: 1`, achievement and asset rows deleted, storage object left behind.
  - Two concurrent first finalizations for one intent: both HTTP 200, two achievements and two assets, intent `consumed` pointing at the second, replay returned that second record, quarantine removed.
  - `initTables` on a pre-feature table: `CREATE TABLE IF NOT EXISTS` did not add the hypothetical new column.
  - Query-only initialization path: created `achievements`, `assets`, `auth_state`, `push_subscriptions`, `rate_limits`, `reminder_attempts`, `sessions`, `storage_objects`, and `upload_intents`.
  - Archive version 1 export/restore round-trip: metadata and asset mappings preserved; five binary objects restored.
  - Archive version 2: rejected before mutation (`Unsupported manifest schema version: 2. Expected version 1.`); unknown metadata field dropped by explicit mapping.
- No production probes, destructive operations, or browser checks were required for this phase.

### Phase 1 (2026-10-27)

- `npm run typecheck`: passed (`tsc --noEmit`, no diagnostics).
- Focused suites: `npx vitest run tests/unit/viewer-transform.test.ts tests/integration/accessibility-performance.test.ts tests/integration/achievements-crud.test.ts tests/integration/gallery-empty-state.test.ts tests/integration/adversarial-m2-gallery.test.ts --fileParallelism=false` passed 35/35 tests in 5 files (`viewer-transform` 4, `accessibility-performance` 8, `achievements-crud` 9, `gallery-empty-state` 2, `adversarial-m2-gallery` 12).
- Browser harness: `node .agent-runtime/phase1-browser-check.mjs` passed 37/37 checks at 1280×900 desktop and 390×844 mobile. Evidence: `.agent-runtime/evidence/phase1-browser-report.json`, `phase1-viewer-desktop.png`, `phase1-viewer-mobile.png`.
- Browser environment: Next dev server on `localhost:3000`, Chrome DevTools on port 9222, synthetic in-memory PGlite database, `MemoryStorageAdapter`, 35 seeded records, filtered "Tie" set spanning 30 records.
- Verified in the browser: detail and viewer request only `type=display`; the viewer fills the viewport inside the detail dialog while leaving it mounted and inert; all three fixed backgrounds; 2× zoom, pointer pan, and Fit reset; Previous disabled at the first item; ArrowLeft/ArrowRight navigation; focus wrap at both ends; one Escape closes only the viewer and restores the "View fullscreen" trigger; a second Escape closes details and restores the gallery card; page-session background persistence; pending-state dedupe and single next-page append; display-asset error with explicit retry; automatic download retry; mobile layout without horizontal overflow; viewport fallback when native fullscreen is unavailable; detail dialog remains after viewer close.
- Throughout the final run, 175 asset requests were observed with 0 `type=original` requests.
- Development-only support was required and committed separately: `serverExternalPackages: ['@electric-sql/pglite']` in `next.config.ts`, and `globalThis` caching for the in-memory PGlite database and storage adapter so Next route compilation does not discard sessions or uploads. A process restart still resets both.
- Skipped/deferred: native fullscreen entry was not exercised in a headed browser; the harness verified the documented viewport fallback when the API is unavailable. Original-resolution inspection remains the existing explicit download action and was not part of viewer browsing.

### Phase 2 (2026-10-27)

- `npm run typecheck`: passed (`tsc --noEmit`, no diagnostics).
- `npx vitest run tests/integration/tag-browser.test.ts`: 7/7 tests passed in 9.94s.
- Focused suites on the final code: `npx vitest run tests/integration/tag-browser.test.ts tests/integration/gallery-pagination.test.ts tests/integration/achievements-crud.test.ts tests/integration/accessibility-performance.test.ts tests/integration/gallery-empty-state.test.ts tests/integration/adversarial-m2-gallery.test.ts` passed 56/56 tests in 6 files, 112.60s.
- Browser harness: `node .agent-runtime/phase2-browser-check.mjs` passed 33/33 checks at 1280×900 desktop and 390×844 mobile. Evidence: `.agent-runtime/phase2-run.log`.
- Browser environment: Next dev server on `localhost:3000`, Chrome DevTools on port 9222, synthetic in-memory PGlite database and `MemoryStorageAdapter`, 35 seeded records recreated through the authenticated dev API after a dev-server restart.
- Verified in the browser: the facet lists sorted distinct tags from all matching ready rows rather than the loaded page; exact `oil` returns `Before`, `Tie 01`, and `Tie 03` while excluding `oil-pastel` and the title-only `Oil sketch study`; search, exact tag, and date filters intersect; clearing dates preserves search and tag; All tags clears only the tag; a retained selected tag stays usable when absent from the latest facet; loading, unavailable-with-retry, and no-tags states; a stale tag response cannot replace a newer facet; editing a tag adds and removes it in the facet without a reload; mobile layout has no horizontal overflow and 44px tag buttons.
- The harness initially exposed a race: `SearchBar` re-emits its debounced cleared query, and `applyFilters` closed the open detail dialog even when the filter set was unchanged. `applyFilters` and `handleSelectTag` now return early for an identical filter set; the add/remove edit-requery checks then kept the detail dialog open until explicitly closed.
- Final SUMMARY: 33 checks, 0 failures, 19 tag requests, 464 asset requests, 0 `type=original` requests.
- Skipped/deferred: trashed-record exclusion in the shared predicate is added once in Phase 7; collection scope in Phase 8; contact-sheet selection clearing in Phase 4.

### Phase 3 (2026-10-27)

- `npm run typecheck`: passed (`tsc --noEmit`, no diagnostics).
- `npx vitest run tests/integration/archive-migrations.test.ts`: 6/6 tests passed in 8.61s. Covered a pre-feature database with an existing row, repeated execution, fresh PGlite initialization, a query-only pooled-style client, failure propagation, and the locked `db:migrate` path including its advisory lock and teardown.
- `npx vitest run tests/integration/thumbnail-framing.test.ts`: 8/8 tests passed in 13.05s. Covered finite-range validation, centered defaults, persistence through item and gallery queries, invalid API payloads (`null`, strings, infinity, out of range), database constraints, archive version 2 round-trip, version 1 centered restore, and rejection of a newer version before database or storage mutation.
- `npx vitest run tests/integration/export-restore.test.ts`: 15/15 tests passed in 26.72s after updating the writer expectation to archive version 2.
- Focused regression suites: `npx vitest run tests/integration/achievements-crud.test.ts tests/integration/gallery-pagination.test.ts tests/integration/tag-browser.test.ts tests/integration/gallery-empty-state.test.ts tests/integration/accessibility-performance.test.ts tests/integration/adversarial-m2-gallery.test.ts` passed 56/56 tests in 6 files.
- Browser harness: `node .agent-runtime/phase3-browser-check.mjs` passed 11/11 checks at 1280×900 desktop and 390×844 mobile. Evidence: `.agent-runtime/evidence/phase3-browser-report.json`, `phase3-framing-desktop.png`, `phase3-framing-mobile.png`.
- Browser environment: dev server restarted after the schema change; synthetic in-memory PGlite database and `MemoryStorageAdapter`; 35 records recreated through the authenticated dev API (`node .agent-runtime/seed.mjs`). The `After` fixture was reset to centered framing before the run and left centered afterward.
- Verified in the browser: an existing card defaults to `50% 50%`; the full display image remains `object-fit: contain` with no framing style; keyboard arrows change both axes; Center resets both to 50%; the 4:3 preview follows the 25%/75% draft; an intercepted failed save preserves that draft and keeps the editor open; retry saves and the gallery card applies `25% 75%`; a hard reload preserves both values; mobile framing controls have no horizontal overflow with a 300px preview and 44px sliders and Center control; 148 derivative asset requests and 0 `type=original` requests.
- The seeded thumbnails are flat-color synthetic images, so browser framing evidence reads computed `object-position` and persistence rather than a visually distinguishable crop; the storage-level checksum and derivative-byte assertions in `thumbnail-framing.test.ts` cover unchanged originals and derivatives.
- Skipped/deferred: applying the upgrade to a real production or copied PostgreSQL database remains a deployment step; this phase proved the same SQL against PGlite and the pooled `db:migrate` path. Trashed-record exclusion remains for Phase 7.

### Phase 4 (2026-10-27)

- `npm run typecheck`: passed (`tsc --noEmit`, no diagnostics).
- `npx eslint` over the changed source and test files: no findings.
- Focused suites: `npx vitest run tests/unit/contact-sheet.test.ts tests/integration/display-asset-bytes.test.ts tests/integration/gallery-pagination.test.ts tests/integration/gallery-empty-state.test.ts tests/integration/achievements-crud.test.ts tests/integration/adversarial-m2-gallery.test.ts tests/integration/thumbnail-framing.test.ts tests/integration/accessibility-performance.test.ts` passed 69/69 tests in 8 files, 117.29s.
- Browser harness: `node .agent-runtime/phase4-browser-check.mjs` passed 37/37 checks at 1280×900 desktop and 390×844 mobile. Evidence: `.agent-runtime/evidence/phase4-browser-report.json`, `phase4-selection-desktop.png`, `phase4-selection-mobile.png`, `phase4-export-error.png`, `phase4-export-canceled.png`, and downloaded sheets `phase4-sheet-three.png` (1616×464), `phase4-sheet-24.png` (2144×2624), `phase4-sheet-order-colors.png` (1616×464), `phase4-sheet-single.png` (560×464), `phase4-sheet-mobile-2.png` (1088×464).
- Browser environment: Next dev server on `localhost:3000`, Chrome DevTools on port 9222, Chrome 156 headless, synthetic in-memory PGlite database and `MemoryStorageAdapter`, 35 seeded records. Three temporary colored fixtures were created through the authenticated API and removed at the end, restoring 35 records and centered `After` framing.
- Verified in the browser: 24 native 44px checkboxes sit outside the open-artwork `article`; ordered selection survives a 24→35 page append; Select loaded caps at 24, disables the remaining 11, and never adds unseen pages; a filter change clears the selection; the three-image sheet is 1616×464 with captions `["After","Tie 01","Before"]`; the 24-image sheet is 2144×2624 with captions matching the visible gallery order; every downloaded PNG is opaque (minimum alpha 255) with white margins; a reverse-order colored selection renders green, yellow, red at the cell centers; contain sizing leaves white inside each colored cell; a long caption ends in a visible ellipsis; a simulated 413 names the affected artwork and downloads nothing; a filter change, Cancel, and logout each abort in-flight work with no download; a post-cancel single-image export downloads 560×464; edit and permanent delete clear selection; mobile selection fits 390px without horizontal overflow; 239 asset requests included 38 same-origin inline display requests and 0 `type=original` requests; no uncaught page exceptions.
- The harness captures gallery card titles rather than assuming numeric `Tie` order, because same-date records are ordered by UUID.
- Skipped/deferred: collection-scope selection clearing belongs to Phase 8 because collections do not exist yet. Download behavior was exercised in Chrome 156 headless only; PNG dimensions, opacity, and pixels were verified with `sharp`. No production probes.

### Phase 5 (2026-10-27)

- `npm run typecheck`: passed (`tsc --noEmit`, no diagnostics).
- `npx eslint` over the changed source and test files: no findings.
- Focused suites: `npm test -- tests/unit/storage-health.test.ts tests/integration/archive-health.test.ts` passed 27/27 tests in 2 files, 45.92s (unit 17, integration 10).
- Source review of the probe timeout changed the implementation before this commit. The earlier wrapper stopped awaiting a slow provider call but left it running, so one batch could put up to nine provider requests in flight: three every three seconds inside the eight-second deadline, despite the apparent three-worker limit. The new `ProviderGate` holds a probe slot until the provider call actually settles. A request that outlives its timeout stays counted, later probes wait for a slot, and results degrade to `unknown` at the batch deadline instead of over-subscribing the provider.
- Regression test `keeps timed-out provider calls counted against the three-request bound` dispatches 12 probes at providers that never settle and asserts exactly three provider calls, `unknown` for every object, and a bounded return. It fails on the previous wrapper with `expected 12 to be 3` and passes on the gated implementation.
- Browser harness rerun on this working tree: `node .agent-runtime/phase5-browser-check.mjs` passed 33/33 checks at 1280×900 desktop and 390×844 mobile. Evidence (local, Git-ignored): `.agent-runtime/evidence/phase5-browser-report.json`, `phase5-health-desktop.png`, `phase5-health-mobile.png`, `phase5-restore-desktop.png`, `phase5-restore-mobile.png`.
- Browser environment: existing Next dev server on `localhost:3000`, Chrome DevTools on port 9222, synthetic in-memory PGlite archive with 35 records, `MemoryStorageAdapter`. The harness intercepts `/api/archive/health` and fulfills deterministic responses, so this run verifies the panel, progress, cancellation, and restore entry point rather than provider probes.
- Verified in the browser: the panel starts idle with no request on login, gallery load, reload, or tag change; 16 of 35 checked while the third batch is held, then cancellation keeps only completed results; a late response after cancellation or after a scope change writes nothing; a full scan uses five batches of `[8,8,8,8,3]` and reports 35 healthy; one missing original, one unverified artwork, and one record without a linked asset read differently; the unverified row offers no restore action; the restore prompt opens over the loaded display preview, names only the missing original, separates file replacement from preserved metadata, and uses one hidden file input; dismissing it keeps the dialog and preview; a normal detail open shows no prompt; 390px layouts have no horizontal overflow and 44px controls.
- Final SUMMARY: 33 checks, 0 failures, 154 asset requests, 0 `type=original` requests, 0 page exceptions. The harness left the archive at its 35 seed records.
- Not verified here: a live Supabase or PostgreSQL metadata probe. No provider credentials or test bucket were used, and the HEAD mapping is covered only by mocked unit tests. Supabase Storage answered HEAD for a missing object with HTTP 400 instead of 404 until issue #323 closed on 2025-09-08; a deployment that still does so, or a bucket/authentication failure, reports `unknown` rather than `missing`, so provider trouble never appears as missing artwork.
- Skipped/deferred: trashed-record exclusion joins these queries in Phase 7, when `trashedAt` exists. Native provider probes, production migration execution, and deployment remain separate work.

### Phase 6 (2026-10-27)

- `npm run typecheck`: passed (`tsc --noEmit`, no diagnostics).
- `npx eslint` over the changed source and test files: no findings.
- New Phase 6 suites: `npx vitest run tests/integration/batch-upload.test.ts tests/integration/batch-upload-limits.test.ts tests/unit/upload-item.test.ts` passed 22/22 tests in 3 files, 19.05s.
- Upload and archive regressions: `npx vitest run tests/integration/batch-upload.test.ts tests/integration/batch-upload-limits.test.ts tests/unit/upload-item.test.ts tests/integration/uploads.test.ts tests/unit/storage-quota.test.ts tests/integration/archive-migrations.test.ts tests/integration/export-restore.test.ts` passed 55/55 tests in 7 files, 77.02s.
- Creation and gallery regressions: `npx vitest run tests/integration/achievements-crud.test.ts tests/integration/gallery-pagination.test.ts tests/integration/adversarial-m2-gallery.test.ts tests/integration/thumbnail-framing.test.ts tests/integration/gallery-empty-state.test.ts` passed 49/49 tests in 5 files, 110.89s.
- One finalize implementation now owns intent-to-artwork promotion. `POST /api/uploads/[id]/finalize` and the older `POST /api/achievements` creation path both call `finalizeUpload`; the second previously duplicated the whole pipeline and bypassed the new binding, replay, cleanup, and accounting rules. The routes keep their own authentication and body-shape validation.
- The row lock is held only for the short binding and commit transactions. Quarantine reads, validation, derivative generation, and permanent writes run outside it, so no database connection is occupied during storage work and uploads stay sequential. A per-intent in-process chain additionally serializes the same intent, which the single-connection PGlite development database requires and which the production row lock makes unnecessary but harmless.
- Permanent keys are intent-specific and immutable (`originals/{achievementId}/{intentId}/...`), recorded in `uploadIntents.permanentKeys` before the first write. A retry rewrites exactly those keys. A replacement retires the superseded keys into `assets.retiredObjects` in the same transaction that swaps the asset row, and an entry is dropped only after every key in it is deleted.
- Quota now counts live originals plus the derivative allowance, retired versions awaiting cleanup, active reservations, and quarantine files whose deletion was not confirmed. Maintenance retries quarantine removal, partial permanent keys, bound pending achievements, and retired versions; an intent is unlinked from its artwork before that artwork is deleted, because the foreign key cascade would otherwise erase the intent's own cleanup record.
- Browser harness: `node .agent-runtime/phase6-browser-check.mjs` passed 20/20 checks at 1280×900 and 390×844, with 0 page exceptions. Evidence (local, Git-ignored): `.agent-runtime/evidence/phase6-browser-report.json`, `phase6-batch-failure.png`, `phase6-batch-mobile.png`.
- Browser environment: Next dev server on `localhost:3000` restarted for the schema change, Chrome DevTools on port 9222, synthetic in-memory PGlite archive reseeded to 35 records with `node .agent-runtime/seed.mjs`. The harness intercepts one finalize request and answers it with HTTP 400 to reproduce a failed middle item.
- Verified in the browser: two selected files create two editable rows with derived titles, one labelled input per field, and one upload control naming the batch; the first finalize failure leaves that row's metadata intact with a visible reason and a 44px Retry while the other item saves; the saved row locks its fields and reports Saved; the retry reaches the server with the same intent ID as the intercepted attempt (three finalize requests, two distinct intents) and saves exactly one artwork, leaving 37 records with no duplicate; the dialog closes and the gallery shows the new artwork; quota reports no active intent and no reservation; a single-file selection works through the same queue; the queue fits a 390px viewport without horizontal overflow; removing a queued item uploads nothing; cleanup returns the archive to its 35 records.
- The harness found two defects that unit tests could not: the modal passed an unbound `fetch` so every browser upload failed with "Illegal invocation", and the quota assertion exposed `POST /api/achievements` as a second finalize implementation that left 35 seed intents uncounted. Both are fixed above.
- Not verified here: the cross-process row lock on a pooled PostgreSQL/Supabase deployment, and a real provider under concurrent finalization. PGlite is single-connection, so the focused tests prove the single-record invariant through the in-process chain and the same code path that issues `SELECT ... FOR UPDATE`. No production backup or migration was executed; the additive upgrades were proven against pre-feature PGlite databases and the locked `db:migrate` path.
- Skipped/deferred: trashed records join these paths in Phase 7, which will also replace the still-swallowing permanent-delete cleanup in `maintenance.ts`. Preview object URLs are no longer created at all, so there is nothing to revoke.

## Completion condition

All nine required ideas have one completed end-to-end phase, focused tests pass, migration and backup compatibility are proven, and browser checks have recorded evidence. Optional #8 remains explicitly deferred unless scheduled.

Experience First keeps navigation, selection, and recovery understandable to the owner. The plan prioritizes retry and deletion invariants where an apparently successful action could otherwise lose data or misreport stored artwork.
