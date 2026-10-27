# Feature plan: filter artwork by completion date

Date: 2026-10-27. Status: implemented and verified in the working tree on 2026-10-27. The proposal below is retained as the design record; see [Verification evidence](#verification-evidence).

The [implementation plan](superpowers/plans/2026-10-27-completion-date-filter.md) contains the ordered code changes, test examples, and verification steps that were followed.

Reviewed the [live website](https://hall-of-achievements.vercel.app/) and repository commit `a0e3bca` on `main`.

## Verification evidence

Implementation matched the proposal: shared calendar validation, inclusive `from`/`to` API bounds, applied filter state and request generations in `HomePage`, and a filtered empty state. No dependencies, migrations, services, or stored-data changes were added.

| Command | Result |
| --- | --- |
| `npm ci` | Installed the locked dependency tree without changing the lockfile. |
| Focused Vitest suite | 47 tests passed. |
| `npm run typecheck` | Passed. |
| `npm run build` | Passed. |
| `git diff --check` | No whitespace errors. |

```powershell
npm test -- tests/unit/achievement-date-validation.test.ts tests/integration/gallery-pagination.test.ts tests/integration/gallery-empty-state.test.ts tests/integration/achievements-crud.test.ts tests/integration/uploads.test.ts tests/integration/accessibility-performance.test.ts
```

Browser verification used headless Chrome through the DevTools protocol against `next dev --turbopack` and a local Postgres test archive. The script exercised 41 checks at 375x800 and 1280x900; all passed. It covered inclusive and open bounds, a single-date range, future filter bounds, text/date intersection, draft isolation, reversed-range feedback, clear-dates behavior, 32-record filtered pagination across same-date ties, filtered empty copy, first-page failure and retry, late first-page and late-append races, double-click append suppression, logout during a pending request, edit-outside-range and delete refreshes, 44 px targets, labels, keyboard order and focus, Enter submission, narrow layout, and absence of push, upload, or original-asset requests.

Local evidence is kept outside the repository at `.agent-runtime/evidence/browser-report.json`, `.agent-runtime/evidence/gallery-375.png`, and `.agent-runtime/evidence/gallery-1280.png`.

Skipped or partial browser checks:

- Create inside and outside an active range, and restore, were not exercised in the browser. The synthetic fixture had no missing-image record. Create uses the same filtered first-page refresh as the verified edit and delete flows; restore reports through the verified edit callback. Existing CRUD and upload integration tests pass.
- Append-failure retry was not exercised in the browser. First-page failure and retry were verified; append requests share the same retry path with a stored cursor.
- A 401 session expiry during a gallery request was not exercised in the browser. Logout during a pending request and unauthenticated API denial were verified.
- The retry control was activated programmatically rather than by keyboard. Tab order and visible focus were verified through Clear dates at 375 px; the 1280 px layout was captured but not re-tabbed.

## Recommendation

Add an optional completion-date range beside the existing gallery search. The owner can revisit a month, a year, or any period without scrolling through the entire archive.

For example, enter `2026-10-01` through `2026-10-31` to revisit October artwork. Add a search term to narrow those results further.

This follows the Experience First principle by improving the existing record-and-revisit workflow. The archive already stores completion dates, so the feature needs no new storage, migration, dependency, or service.

## What exists today

The website provides a private gallery, artwork uploads, detail and metadata editing, original downloads, storage usage, and manual push reminders.

The current gallery request follows this path:

1. [HomePage](../src/app/page.tsx) loads the first page and owns search, pagination, and mutation callbacks.
2. [SearchBar](../src/components/gallery/SearchBar.tsx) debounces text input for 300 milliseconds. Its visible label mentions titles and tags.
3. [GET /api/achievements](../src/app/api/achievements/route.ts) authenticates the request, then searches titles, tags, and notes.
4. The query returns only `ready` achievements, ordered by completion date and ID descending. The default page contains 24 records.
5. [GalleryGrid](../src/components/gallery/GalleryGrid.tsx) renders cards and a Load More button. Cards resolve private thumbnails separately.

At the reviewed baseline, the [database schema](../src/lib/db/schema.ts) already had a completion-date column and indexes for gallery queries. Date filtering was absent from the gallery UI and GET handler.

Some older planning documents and the README describe an unimplemented application. This proposal uses the current source and observed website as its baseline.

## Proposed experience

Add a compact form next to the existing search with these controls:

- **Completed from**, a native date input with an optional lower bound.
- **Completed through**, a native date input with an optional upper bound.
- **Apply dates**, which submits both inputs together.
- **Clear dates**, which removes both bounds and preserves text search.

Both dates are inclusive. Either input can stand alone. Both empty inputs restore the gallery without date restrictions. Future filter bounds are valid even though saving future completion dates remains prohibited.

Keep draft input values separate from the applied range. Applying an invalid range shows a field-associated error and keeps the previous results. Changing text search uses the currently applied dates.

Applying or clearing dates starts at page one. Load More retains the active search and dates. If no artwork matches any active filter, show "No matching achievements" with guidance to change or clear filters. Reserve the first-artwork prompt for an empty unfiltered gallery.

Show a loading status during requests and a visible error with a retry action on failure. Preserve filter inputs. Do not present results from an older filter as matches for a newly applied filter. Describe the displayed count as loaded results, since the API does not return an archive-wide total.

Use associated labels, keyboard submission, visible focus, and touch targets of at least 44 CSS pixels for buttons. Let the form wrap on narrow screens.

## API and data contract

Extend the existing authenticated endpoint with two optional query parameters:

```text
GET /api/achievements?q=portrait&from=2026-10-01&to=2026-10-31&limit=24
```

| Parameter | Rule |
| --- | --- |
| `from` | Include records whose `completionDate` is greater than or equal to this calendar date. |
| `to` | Include records whose `completionDate` is less than or equal to this calendar date. |
| Both | Combine the bounds with existing text search, ready-state filtering, and cursor conditions using AND. |
| Missing or empty | Omit that bound. Whitespace-only values count as empty. |

Validate nonempty values as real calendar dates in `YYYY-MM-DD` format. Reject malformed dates, impossible dates, or `from > to` with HTTP 400 and the existing JSON error shape. Validate before building the query, after authentication.

Treat bounds as calendar-date strings without converting them to timestamps or applying timezone offsets. Add parameterized Drizzle `gte` and `lte` conditions in the existing GET handler.

Keep the response contract `{ items, nextCursor, hasMore }`, page-size limits, descending ordering, and cursor format unchanged. A cursor is used with the same active filter values. Clients restart pagination whenever those values change.

Preserve authentication, private cache headers, ready-state exclusion, and signed asset access. Filtering must not issue pushes or fetch original images.

## Implementation scope

| File | Planned change |
| --- | --- |
| [src/app/page.tsx](../src/app/page.tsx) | Add date controls and draft values. Own applied search and dates together. Use the same request parameters for first-page loads, retries, and pagination. Reset cursors on filter changes. Handle stale responses, errors, and mutation refreshes. |
| [src/app/api/achievements/route.ts](../src/app/api/achievements/route.ts) | Parse and validate the range. Add inclusive bounds to the existing query conditions. |
| [src/lib/validation/achievement.ts](../src/lib/validation/achievement.ts) | Extract the existing calendar-date check for reuse by range validation. Keep the timezone and no-future-date rules in `validateCompletionDate` for writes. |
| [src/components/gallery/GalleryGrid.tsx](../src/components/gallery/GalleryGrid.tsx) | Recognize date filters when choosing empty-state copy. Preserve the existing card and pagination behavior. |
| [tests/integration/gallery-pagination.test.ts](../tests/integration/gallery-pagination.test.ts) | Extend API coverage for bounds, search combinations, validation, and filtered pagination. |
| `tests/unit/achievement-date-validation.test.ts`, new | Test shared calendar validation, leap dates, range order, and the distinction between filter and write validation. |

Keep `SearchBar`, gallery response types, card and modal props, uploads, storage adapters, configuration, and export formats unchanged. Reuse the page's existing modal callbacks to refresh results.

All callers of `validateCompletionDate` must retain their current behavior. These are achievement creation, metadata updates in [the item route](../src/app/api/achievements/[id]/route.ts), and [upload finalization](../src/app/api/uploads/[id]/finalize/route.ts).

## Delivery order and checks

1. Extract and test calendar validation. Add API range validation and SQL conditions. Verify inclusive and open bounds before adding controls.
2. Add the form and applied filter state. Pass the same filters to every gallery request. Reuse the existing search debounce.
3. Invalidate older requests when filters change or a mutation refresh starts. Use a request generation guard for response and loading-state updates. An older Load More response must never append to a newer result set.
4. After a successful create, edit, restore, or delete, reload page one under the active filters. Keep the selected detail updated where appropriate. Preserve existing quota refreshes. Avoid unconditional prepend and in-place gallery replacement, which can violate filters and ordering.
5. Add filtered empty states, accurate loaded-result wording, request errors, and retry behavior. Complete the checks below.

Run the focused suite after implementation:

```powershell
npm ci
npm test -- tests/unit/achievement-date-validation.test.ts tests/integration/gallery-pagination.test.ts tests/integration/achievements-crud.test.ts tests/integration/uploads.test.ts
npm run typecheck
```

Then verify the interactive cases in a local test archive. Use synthetic records and simulated network failures for mutation and race checks.

## Acceptance criteria

- [x] With no bounds, the existing gallery and search behave as before.
- [x] Records exactly on either bound appear. Equal bounds select a single completion date. Each bound also works alone.
- [x] Valid leap days work. Invalid leap days, malformed values, impossible dates, and reversed ranges return HTTP 400. Future filter bounds work, while future completion-date writes still fail.
- [x] Text search intersects the date range, including existing notes search. Pending and deleting records remain excluded.
- [x] More than 24 matching records, including same-date ties, paginate without duplicates or omissions when records are unchanged.
- [x] Changing filters resets the cursor. Rapid changes and an in-flight Load More request cannot mix filters or overwrite newer results.
- [x] Clear dates preserves search. A date-only empty result shows the filtered empty state. Counts describe loaded results.
- [ ] Create and edit operations respect the active range and ordering. Editing an item outside the range removes it from the gallery after refresh. Restore and delete refresh safely. **Partial:** edit-outside-range and delete were verified in the browser; create and restore were not.
- [ ] Failed first-page and pagination requests show an error and permit retry without losing inputs or appending duplicate results. **Partial:** first-page failure and retry were verified; append failure and retry were not browser-tested.
- [x] An unauthenticated filtered request is denied. Successful and error responses retain private cache headers.
- [ ] Keyboard and narrow-screen checks pass for labels, Apply, Clear, focus, validation feedback, and retry. Filters cause no notification prompt, push send, or original-image download. **Partial:** labels, focus, Enter submission, validation feedback, narrow layout, and side effects were verified; retry was activated programmatically and desktop tab order was not repeated.

## Limits and rollback

This proposal adds only completion-date filtering. It excludes charts, streaks, sorting modes, saved filters, URL persistence, public sharing, and automatic reminders. Existing index performance is unmeasured. Consider index changes only if representative filtered queries show a problem.

The implementation changes no stored artwork or metadata and requires no migration. Roll back by reverting the feature changes. Existing clients that omit the new parameters remain compatible.

This planning task includes a repository checkout, source review, and read-only inspection of the live gallery. Implementation and verification results, including remaining gaps, are recorded in [Verification evidence](#verification-evidence).
