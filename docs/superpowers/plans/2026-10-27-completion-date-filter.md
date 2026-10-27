# Completion-date filter implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let the owner filter artwork by an inclusive completion-date range while retaining search, pagination, privacy, and correct results after mutations.

**Architecture:** Extend the existing authenticated gallery query with optional `from` and `to` bounds. Keep applied filters and request ownership in `HomePage`. Reuse calendar validation and the existing gallery components, database indexes, and modal callbacks.

**Tech stack:** Next.js 15 App Router, React 19, TypeScript, Drizzle ORM, PostgreSQL, Vitest, and PGlite for hermetic integration tests.

**Spec:** [Feature proposal](../../FEATURE-PLAN.md). Read both documents before implementation.

**Baseline:** Commit `a0e3bca`. Executed on 2026-10-27. See [Verification evidence](../../FEATURE-PLAN.md#verification-evidence) for automated results, browser evidence, and skipped checks.

## Global constraints

- Both dates are inclusive. Either input can stand alone.
- Future filter bounds are valid even though saving future completion dates remains prohibited.
- Treat bounds as calendar-date strings without converting them to timestamps or applying timezone offsets.
- Keep the response contract `{ items, nextCursor, hasMore }`, page-size limits, descending ordering, and cursor format unchanged.
- Preserve authentication, private cache headers, ready-state exclusion, and signed asset access.
- Filtering must not issue pushes or fetch original images.
- Keep the existing 300-millisecond search debounce.
- Use associated labels, keyboard submission, visible focus, and touch targets of at least 44 CSS pixels for buttons.
- Add no dependencies, database migrations, services, environment settings, saved filters, charts, or automatic reminders.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| `src/lib/validation/achievement.ts` | Shared calendar validation and optional date-range validation. Write-specific timezone and future-date rules stay in `validateCompletionDate`. |
| `src/app/api/achievements/route.ts` | Parse bounds after authentication and apply inclusive conditions before pagination. |
| `src/app/page.tsx` | Draft date controls, applied filters, request ownership, retry, cursor resets, mutation refreshes, and result status. |
| `src/components/gallery/GalleryGrid.tsx` | Distinguish filtered emptiness from an empty archive. |
| `tests/unit/achievement-date-validation.test.ts`, new | Calendar and range behavior, including write-validation regressions. |
| `tests/integration/gallery-pagination.test.ts` | API behavior, private headers, intersection with search, and pagination across date ties. |
| `tests/integration/gallery-empty-state.test.ts`, new | Observable empty-state copy using installed React server rendering. |
| `vitest.config.ts` | Use the automatic JSX transform when the new rendered-component test imports TSX. |
| `docs/FEATURE-PLAN.md` | Record final implementation status and completed acceptance evidence. |

Keep `SearchBar`, `GalleryResponse`, storage, schema, exports, and modal contracts unchanged. Do not extract a request service or generic filtering framework. The existing page owns these interactions.

## Task 1: Share calendar validation and validate ranges

**Files:** Modify `src/lib/validation/achievement.ts`. Create `tests/unit/achievement-date-validation.test.ts`.

**Interfaces:**

- Produce `validateCalendarDate(value: unknown): string`.
- Produce `validateDateRange(from: string | null | undefined, to: string | null | undefined): { from: string; to: string }`.
- Preserve `validateCompletionDate(dateStr: unknown, timezone?: string): string` for achievement POST, item PATCH, and upload finalization.

- [x] Install the locked dependencies with `npm ci` if they are absent. Do not update the lockfile.
- [x] Add the following unit tests.

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	validateCalendarDate,
	validateCompletionDate,
	validateDateRange,
} from '@/lib/validation/achievement';

afterEach(() => vi.useRealTimers());

describe('achievement date validation', () => {
	it('accepts a leap day and rejects impossible or malformed dates', () => {
		expect(validateCalendarDate('2024-02-29')).toBe('2024-02-29');
		for (const value of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '2026-10-01T00:00:00Z', null]) {
			expect(() => validateCalendarDate(value)).toThrow();
		}
	});

	it('normalizes empty and open bounds without rejecting future filters', () => {
		expect(validateDateRange(null, ' ')).toEqual({ from: '', to: '' });
		expect(validateDateRange(' 2026-10-01 ', '')).toEqual({ from: '2026-10-01', to: '' });
		expect(validateDateRange('', '2099-12-31')).toEqual({ from: '', to: '2099-12-31' });
		expect(validateDateRange('2026-10-01', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
	});

	it('rejects reversed ranges', () => {
		expect(() => validateDateRange('2026-10-02', '2026-10-01')).toThrow('Completed from must not be after Completed through.');
	});

	it('preserves timezone-aware future-date rejection for writes', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-27T18:00:00Z'));
		expect(validateCompletionDate('2026-10-28', 'Asia/Makassar')).toBe('2026-10-28');
		expect(() => validateCompletionDate('2026-10-28', 'UTC')).toThrow();
		expect(() => validateCompletionDate('2026-10-28', 'Invalid/Timezone')).toThrow();
	});
});
```

- [x] Run `npm test -- tests/unit/achievement-date-validation.test.ts`. Expect failure because the new exports do not exist.
- [x] Move the existing format, type, and calendar checks from `validateCompletionDate` into `validateCalendarDate`. Preserve the existing `ValidationError` codes and messages. End the extracted function with `return dateStr`. Replace the moved block in `validateCompletionDate` with `validateCalendarDate(dateStr)`. Keep its timezone calculation, fallback, future-date rejection, and return value intact.

The resulting function boundary is:

```ts
export function validateCompletionDate(dateStr: unknown, timezone?: string): string {
	const validatedDate = validateCalendarDate(dateStr);
```

Use `validatedDate` for the remaining comparison and return because TypeScript cannot narrow `dateStr` through a normal function call. Preserve the existing timezone code between that boundary and these statements:

```ts
if (validatedDate > todayInTz) {
	throw new ValidationError(
		'INVALID_COMPLETION_DATE',
		`Completion date cannot be in the future (today is ${todayInTz} in timezone ${resolvedTimezone}).`
	);
}
return validatedDate;
```

- [x] Add range validation in the same module.

```ts
export function validateDateRange(
	from: string | null | undefined,
	to: string | null | undefined
): { from: string; to: string } {
	const start = from?.trim() ?? '';
	const end = to?.trim() ?? '';
	if (start) validateCalendarDate(start);
	if (end) validateCalendarDate(end);
	if (start && end && start > end) {
		throw new ValidationError('INVALID_DATE_RANGE', 'Completed from must not be after Completed through.');
	}
	return { from: start, to: end };
}
```

- [x] Run the unit file, `tests/integration/achievements-crud.test.ts`, and `tests/integration/uploads.test.ts`. Expect all checks to pass. The latter two protect every existing write caller.
- [x] Review the diff and checkpoint the validation change with `git commit -m "refactor: share achievement calendar validation"` after staging only its two files.

## Task 2: Filter the authenticated gallery query

**Files:** Modify `src/app/api/achievements/route.ts` and `tests/integration/gallery-pagination.test.ts`.

**Interfaces:** Consume `validateDateRange`. Produce optional `from` and `to` query parameters on the existing GET endpoint. Preserve `GalleryResponse` and the date/UUID cursor.

- [x] Add these tests inside the existing gallery test suite so its `beforeEach` database reset applies. They use the imports and authenticated-header helper already in that file.

```ts
it.each([
	['from=2026-10-01&to=2026-10-31', ['Start', 'Middle', 'End']],
	['from=2026-10-15&to=2026-10-15', ['Middle']],
	['from=2026-10-31', ['End', 'After']],
	['to=2026-10-01', ['Before', 'Start']],
	['from=&to=%20', ['Before', 'Start', 'Middle', 'End', 'After']],
	['from=2099-01-01', []],
	['from=2026-10-01&to=2026-10-31&q=needle', ['Middle']],
])('applies inclusive bounds and text search for %s', async (query, expected) => {
	const { headers } = await createAuthenticatedHeaders();
	const db = await getDb();
	const values = [
		{ title: 'Before', completionDate: '2026-09-30' },
		{ title: 'Start', completionDate: '2026-10-01' },
		{ title: 'Middle', completionDate: '2026-10-15', notes: 'needle' },
		{ title: 'End', completionDate: '2026-10-31' },
		{ title: 'After', completionDate: '2026-11-01' },
	];
	await db.insert(achievements).values(values.map(value => ({
		...value, id: crypto.randomUUID(), state: 'ready' as const,
	})));
	const response = await galleryHandler(new NextRequest(`http://localhost:3000/api/achievements?${query}`, { headers }));
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toContain('private');
	expect(response.headers.get('cache-control')).toContain('no-store');
	const data = await response.json() as { items: Array<{ title: string }> };
	expect(data.items.map(item => item.title).sort()).toEqual([...expected].sort());
});

it.each([
	'from=2026-02-30', 'to=2025-02-29', 'from=not-a-date',
	'from=2026-10-02&to=2026-10-01',
])('rejects invalid bounds for %s', async query => {
	const { headers } = await createAuthenticatedHeaders();
	const response = await galleryHandler(new NextRequest(`http://localhost:3000/api/achievements?${query}`, { headers }));
	expect(response.status).toBe(400);
	expect(response.headers.get('cache-control')).toContain('no-store');
	expect(await response.json()).toEqual(expect.objectContaining({
		error: expect.any(String), code: expect.any(String),
	}));
});

it('authenticates before validating date filters', async () => {
	const response = await galleryHandler(new NextRequest('http://localhost:3000/api/achievements?from=invalid'));
	expect(response.status).toBe(401);
	expect(response.headers.get('cache-control')).toContain('no-store');
});

it('paginates a filtered range across same-date ties without mixing states', async () => {
	const { headers } = await createAuthenticatedHeaders();
	const db = await getDb();
	const expectedIds = Array.from({ length: 50 }, () => crypto.randomUUID());
	await db.insert(achievements).values([
		...expectedIds.map(id => ({ id, title: 'Match', completionDate: '2026-10-15', state: 'ready' as const })),
		{ id: crypto.randomUUID(), title: 'Outside', completionDate: '2026-09-30', state: 'ready' },
		{ id: crypto.randomUUID(), title: 'Match', completionDate: '2026-10-15', state: 'pending' },
		{ id: crypto.randomUUID(), title: 'Match', completionDate: '2026-10-15', state: 'deleting' },
	]);
	const received: string[] = [];
	let cursor: string | null = null;
	let finished = false;
	for (let page = 0; page < 3; page++) {
		const params = new URLSearchParams({ from: '2026-10-01', to: '2026-10-31', q: 'Match', limit: '24' });
		if (cursor) params.set('cursor', cursor);
		const response = await galleryHandler(new NextRequest(`http://localhost:3000/api/achievements?${params}`, { headers }));
		expect(response.status).toBe(200);
		const data = await response.json() as {
			items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean;
		};
		received.push(...data.items.map(item => item.id));
		cursor = data.nextCursor;
		if (!data.hasMore) { finished = true; break; }
	}
	expect(finished).toBe(true);
	expect(cursor).toBeNull();
	expect(received).toHaveLength(50);
	expect(new Set(received)).toEqual(new Set(expectedIds));
	expect(received).toEqual([...received].sort().reverse());
});
```

- [x] Run `npm test -- tests/integration/gallery-pagination.test.ts`. Expect new range tests to fail while existing pagination tests pass.
- [x] Import `gte` and `lte` from Drizzle and `validateDateRange` from the existing validation module. Immediately after constructing `url`, validate its bounds in a separate block. Keep this block after authentication and outside the database error catch.

```ts
let range: { from: string; to: string };
try {
	range = validateDateRange(url.searchParams.get('from'), url.searchParams.get('to'));
} catch (err) {
	if (err instanceof ValidationError) return jsonError(err.message, err.statusCode, err.code);
	throw err;
}
```

- [x] After `const conditions = [eq(achievements.state, 'ready')]`, add the bounds. Keep the existing search escaping, cursor comparison, order, join, limit, and response unchanged.

```ts
if (range.from) conditions.push(gte(achievements.completionDate, range.from));
if (range.to) conditions.push(lte(achievements.completionDate, range.to));
```

- [x] Rerun the gallery suite and `npm run typecheck`. Expect success, including existing no-filter tests.
- [x] Stage only the route and integration test, then checkpoint with `git commit -m "feat: filter gallery by completion date"`.

## Task 3: Keep gallery requests consistent with applied filters

**Files:** Modify `src/app/page.tsx`.

**Interfaces:** Consume the existing `GalleryResponse` and the new query parameters. Produce page-local `GalleryFilters`, `fetchAchievements(filters, pageCursor?)`, and `applyFilters(next)`. Do not change modal callback types.

- [x] Import `useRef`. Replace `searchQuery` state with one applied filter object. Add the following page-local types, constant, state, and refs. Put the type and constant outside `HomePage`.

```ts
type GalleryFilters = { q: string; from: string; to: string };
const EMPTY_FILTERS: GalleryFilters = { q: '', from: '', to: '' };

const [filters, setFilters] = useState<GalleryFilters>(EMPTY_FILTERS);
const [galleryError, setGalleryError] = useState<string | null>(null);
const [failedCursor, setFailedCursor] = useState<string | null>(null);
const requestGeneration = useRef(0);
const requestBusy = useRef(false);
```

- [x] Replace both existing request implementations with one callback. A first-page request clears old records immediately. An append failure preserves records and its cursor. Only the latest request can update records, errors, or loading state.

```ts
const fetchAchievements = useCallback(async (active: GalleryFilters, pageCursor: string | null = null) => {
	if (pageCursor && requestBusy.current) return;
	const generation = ++requestGeneration.current;
	requestBusy.current = true;
	setGalleryLoading(true);
	setGalleryError(null);
	setFailedCursor(null);
	if (!pageCursor) {
		setItems([]);
		setCursor(null);
		setHasMore(false);
	}
	try {
		const params = new URLSearchParams({ limit: '24' });
		if (active.q) params.set('q', active.q);
		if (active.from) params.set('from', active.from);
		if (active.to) params.set('to', active.to);
		if (pageCursor) params.set('cursor', pageCursor);
		const response = await fetch(`/api/achievements?${params}`);
		if (generation !== requestGeneration.current) return;
		if (response.status === 401) {
			setSession({ authenticated: false });
			setItems([]);
			setSelectedAchievement(null);
			setCursor(null);
			setHasMore(false);
			return;
		}
		if (!response.ok) throw new Error('Failed to load artwork. Please retry.');
		const data = await response.json() as GalleryResponse;
		if (generation !== requestGeneration.current) return;
		setItems(previous => pageCursor ? [...previous, ...data.items] : data.items);
		setCursor(data.nextCursor);
		setHasMore(data.hasMore);
	} catch {
		if (generation === requestGeneration.current) {
			setGalleryError('Failed to load artwork. Please retry.');
			setFailedCursor(pageCursor);
		}
	} finally {
		if (generation === requestGeneration.current) {
			requestBusy.current = false;
			setGalleryLoading(false);
		}
	}
}, []);

const applyFilters = (next: GalleryFilters) => {
	setFilters(next);
	void fetchAchievements(next);
};

const handleSearch = useCallback((q: string) => {
	const next = { ...filters, q };
	setFilters(next);
	void fetchAchievements(next);
}, [filters, fetchAchievements]);

const handleLoadMore = async () => {
	if (cursor) await fetchAchievements(filters, cursor);
};
```

- [x] Keep `fetchAchievements` stable. Pass `EMPTY_FILTERS` explicitly from the existing initial-load effect. Do not add `filters` to that effect, which would turn each search into another session check.
- [x] On successful login, reset `filters` to `EMPTY_FILTERS` and call `fetchAchievements(EMPTY_FILTERS)`. On successful logout, increment `requestGeneration.current`, set `requestBusy.current` to false, reset loading, clear items, selected detail, cursor, errors, and filters. An older authenticated response must not repopulate a later session.
- [x] Invalidate request ownership on page unmount.

```ts
useEffect(() => () => { requestGeneration.current++; }, []);
```

- [x] Replace mutation callbacks with filtered first-page refreshes. A restore already invokes `onUpdate`, so its modal requires no change.

```ts
const handleAddSuccess = () => {
	void fetchAchievements(filters);
	void fetchQuota();
};

const handleUpdateAchievement = (updated: AchievementItem) => {
	setSelectedAchievement(updated);
	void fetchAchievements(filters);
};

const handleDeleteAchievement = () => {
	setSelectedAchievement(null);
	void fetchAchievements(filters);
	void fetchQuota();
};
```

- [x] Until Task 4 changes the grid interface, pass `filters.q` to its existing `searchQuery` prop. Run `npm run typecheck` and the existing gallery suite. Verify that no callers of the old no-argument `fetchAchievements` remain with `rg -n 'fetchAchievements|searchQuery' src/app/page.tsx`.
- [x] During the Task 4 browser checks, verify request generations using delayed responses and double-clicked pagination. Do not add a test framework or extract a production service just to expose these local callbacks.

## Task 4: Add accessible controls and complete user-visible states

**Files:** Modify `src/app/page.tsx`, `src/components/gallery/GalleryGrid.tsx`, and `vitest.config.ts`. Create `tests/integration/gallery-empty-state.test.ts`. Update `docs/FEATURE-PLAN.md` after verification.

**Interfaces:** Consume `validateDateRange`, `GalleryFilters`, `applyFilters`, and `fetchAchievements`. Replace the grid's `searchQuery: string` prop with `hasActiveFilters: boolean`. Its only caller is `HomePage`.

- [x] Import `validateDateRange` in the page. Add draft input state and a field error.

```ts
const [draftFrom, setDraftFrom] = useState('');
const [draftTo, setDraftTo] = useState('');
const [dateError, setDateError] = useState<string | null>(null);

const handleApplyDates = (event: FormEvent) => {
	event.preventDefault();
	try {
		const range = validateDateRange(draftFrom, draftTo);
		setDateError(null);
		applyFilters({ ...filters, ...range });
	} catch (error) {
		setDateError(error instanceof Error ? error.message : 'Enter a valid date range.');
	}
};

const handleClearDates = () => {
	setDraftFrom('');
	setDraftTo('');
	setDateError(null);
	applyFilters({ ...filters, from: '', to: '' });
};
```

- [x] Reset draft dates and date errors when resetting filters on login or logout. Replace the search's loading-based disabling with an enabled search control so the owner can supersede a pending request.
- [x] Add this form beside search. Reuse the surrounding spacing and color conventions. Do not set a `max` date, since future filter bounds are valid.

```tsx
<form onSubmit={handleApplyDates} aria-label="Filter by completion date"
	style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 12 }}>
	<label htmlFor="completed-from">Completed from
		<input id="completed-from" type="date" value={draftFrom}
			onChange={event => setDraftFrom(event.target.value)}
			aria-invalid={Boolean(dateError)} aria-describedby={dateError ? 'date-range-error' : undefined}
			style={{ display: 'block', minHeight: 44 }} />
	</label>
	<label htmlFor="completed-through">Completed through
		<input id="completed-through" type="date" value={draftTo}
			onChange={event => setDraftTo(event.target.value)}
			aria-invalid={Boolean(dateError)} aria-describedby={dateError ? 'date-range-error' : undefined}
			style={{ display: 'block', minHeight: 44 }} />
	</label>
	<button type="submit" style={{ minWidth: 44, minHeight: 44 }}>Apply dates</button>
	<button type="button" onClick={handleClearDates} style={{ minWidth: 44, minHeight: 44 }}>Clear dates</button>
	{dateError && <p id="date-range-error" role="alert">{dateError}</p>}
</form>
```

- [x] Render a polite status for loading and loaded results. Suppress the count while an error is shown.

```tsx
<p role="status" aria-live="polite">
	{galleryLoading ? 'Loading artwork...' : galleryError ? '' : `${items.length} ${items.length === 1 ? 'artwork' : 'artworks'} loaded`}
</p>
{galleryError && <div role="alert">
	<p>{galleryError}</p>
	<button type="button" disabled={galleryLoading}
		onClick={() => void fetchAchievements(filters, failedCursor)}
		style={{ minWidth: 44, minHeight: 44 }}>Retry loading artwork</button>
</div>}
```

- [x] Render `GalleryGrid` only when `!galleryError || items.length > 0`. A failed first page must not look like an empty archive. During append errors, retain cards but pass `hasMore={hasMore && !galleryError}` so the retry button is the only pagination action.
- [x] Replace `searchQuery` with `hasActiveFilters` in the grid prop type and destructuring. Use it in the empty-state branch. Replace the search-specific paragraph with `No artwork matches the current filters. Change your search or clear the dates.` Pass `Boolean(filters.q || filters.from || filters.to)` from the page.
- [x] Add a behavior check using the installed `react-dom/server`. No DOM testing dependency is needed for this rendered-copy test.

Set `esbuild: { jsx: 'automatic' }` at the top level of the existing `defineConfig` object in `vitest.config.ts`. This lets Vitest import the application's TSX with its React JSX runtime without requiring a global `React` variable. Preserve the existing test and alias settings.

```ts
esbuild: { jsx: 'automatic' },
```

```ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';

describe('gallery empty state', () => {
	it.each([true, false])('renders the correct empty state when filters are %s', hasActiveFilters => {
		const html = renderToStaticMarkup(createElement(GalleryGrid, {
			items: [], loading: false, hasMore: false, hasActiveFilters,
			onLoadMore: () => {}, onSelectAchievement: () => {},
		}));
		expect(html).toContain(hasActiveFilters ? 'No matching achievements' : 'Your archive is waiting for your art');
		expect(html).not.toContain(hasActiveFilters ? 'Your archive is waiting for your art' : 'No matching achievements');
	});
});
```

- [x] Run the focused automated proof.

```powershell
npm test -- tests/unit/achievement-date-validation.test.ts tests/integration/gallery-pagination.test.ts tests/integration/gallery-empty-state.test.ts tests/integration/achievements-crud.test.ts tests/integration/uploads.test.ts tests/integration/accessibility-performance.test.ts
npm run typecheck
git diff --check
```

The existing accessibility suite uses source assertions as well as image checks. Keep those assertions meaningful when the JSX changes. Do not claim they prove keyboard interaction or real network performance.

- [x] Start `npm run dev` using a local test archive and test credentials. Use the existing `.env.example` and documented storage setup. Use synthetic art and no production credentials. The automated integration tests use their existing PGlite setup and do not require a live database.
- [x] Complete this browser checklist. Record pass or failure, the viewport, and any unresolved defect in the proposal's verification section.

| Scenario | Action and expected result |
| --- | --- |
| Basic bounds | Apply dates including known boundary records. Both boundary records appear. An equal-date range contains only that day. Each bound works alone. |
| Search and drafts | Apply dates, type a search term, then edit a draft date without applying. Requests keep the last applied dates. Clear dates preserves the search text and request `q`. |
| Validation | Submit a reversed range. Both controls reference the visible error. The existing results and applied range remain unchanged. A future upper bound is accepted. |
| Pagination | Use more than 24 matching synthetic records with same-date ties. Load all pages and verify every matching ID appears once. |
| Late first page | Delay a request for range A, then apply range B and let B finish first. Completing A cannot replace B's items, count, error, or loading status. |
| Late append | Delay Load More for A, then apply B. Completing A cannot append its records to B. Double-clicking Load More starts only one append request. |
| First-page failure | Fail the latest request with HTTP 500. Show an error and retry without empty-archive copy. Inputs remain intact. Retry requests the active range without a cursor. |
| Append failure | Fail Load More. Keep existing cards. Retry sends the failed cursor with the same filters and appends each returned record once. |
| Mutations | Under an active range, create inside and outside it. Edit an item outside the range, then delete another. Each success reloads page one under the active filters. Test restore if the synthetic fixture offers a missing image. Detail stays open after edit or restore. |
| Privacy and session | Log out during a pending gallery request. Its later completion cannot populate the logged-out page. Expired-session responses return to login. |
| Empty states | A date-only range with no results shows filtered empty copy. An empty archive without filters shows the Add Achievement prompt. |
| Access and layout | At 375 CSS pixels and a desktop width, tab through search, dates, Apply, Clear, and retry. Verify visible focus, field labels, Enter submission, error announcement, wrapping, and no horizontal overflow. |
| Side effects | Inspect requests while applying, clearing, and paginating. Only gallery and existing thumbnail requests occur. There is no notification prompt, push request, or original download. |

- [x] Update `docs/FEATURE-PLAN.md` with a link to this plan, final status, commands run, and browser evidence. Check acceptance boxes only for verified behavior. Record any failed or skipped check explicitly.
- [x] Stage only the gallery UI changes, JSX test configuration, new empty-state test, and updated documentation. Checkpoint with `git commit -m "feat: add completion date controls to gallery"`.

## Completion and rollback

The feature is ready for review when the focused checks pass and the browser cases have recorded evidence. No deployment, production data change, or merge is part of this plan.

Revert the feature commits to roll back. No stored data or backup format changes. Existing API clients that omit bounds remain compatible. Index tuning stays outside this task unless representative queries demonstrate a problem.

The Experience First principle keeps the implementation focused on revisiting artwork. Request-race and mutation checks are required because they protect the accuracy of that experience.
