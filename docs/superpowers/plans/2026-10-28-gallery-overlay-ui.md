# Gallery overlay UI implementation plan

Date: 2026-10-28. Status: implementation in the working tree; final verification pending.

The [2026-10-29 minimal gallery plan](2026-10-29-minimal-gallery-layout.md) supersedes this document's visual layout. Retain the implementation and verification history below when continuing.

## Outcome

Make the private archive's artwork and search visible immediately after login. Open secondary tools in accessible overlays without losing a filter draft, collection state, an archive health scan, or notification cooldown. Keep the existing upload, artwork detail, viewer, and contact sheet workflows usable.

## Starting checkpoint

- Branch `main` is at `133c976` and matches `origin/main`. The overlay changes below are local and uncommitted. The deployed site still reflects its own deployment, not these local changes.
- The earlier live-site review found the gallery below a tall stack of tool panels. The local revision moves search and artwork near the top. Those observations used different viewport sizes, so they are layout observations, not a controlled speed or height comparison.
- Read [AGENTS.md](../../../AGENTS.md) and the [Phase 8 handoff](../../CONTINUE-HERE.md) before continuing. Preserve the current owner's other local changes.

## Design and ownership

`HomePage` owns one `GalleryTool | null` value: `filters`, `collections`, `health`, `trash`, or `notifications`. It also owns applied filters, selected collection, gallery requests, detail navigation generations, and session cleanup. Five persistent `ToolDialog` instances keep their panel state mounted while only the active one calls native `showModal()`. `ToolDialog` owns focus return, Escape handling, and body scroll locking. The existing panels retain their own mutations, confirmation, retry, and scan logic.

This keeps one tool open at a time and leaves contact sheet selection beside the gallery. Opening a tool closes artwork detail. Closing or switching a tool invalidates a pending health-to-detail navigation. The health panel may continue scanning while closed; its existing cancellation and revision handling still apply. No API, database, dependency, or archive-format change is required.

## Files in scope

| File | Responsibility |
| --- | --- |
| `src/app/page.tsx` | Compact app bar, search and tool triggers, applied scope, persistent dialogs, collection selection, health-to-detail handoff, and session/navigation ownership. |
| `src/app/globals.css` | Responsive toolbar and dialog layout, visible controls, narrow-screen scrolling, and overlay styling. |
| `src/components/gallery/ToolDialog.tsx` | Native modal lifecycle, labelled dialog, Close/Escape, scroll lock, and focus restoration. |
| `src/components/gallery/AchievementDetailModal.tsx` | Keep its keyboard listener inactive when no artwork is selected. |
| `src/components/gallery/{CollectionPanel,TrashPanel,ArchiveHealthPanel}.tsx` | Remove redundant expand controls and explain background health checks without changing panel operations. |
| `tests/integration/{gallery-tools,accessibility-performance}.test.ts` | Dialog markup and current keyboard behavior. Add focused behavior checks only for a defect found during the remaining sweep. |

## Implementation checklist

- [x] Replace the tall tool-panel stack with a compact search toolbar and five named tool triggers.
- [x] Show the active collection, date range, and tag above gallery results.
- [x] Keep each tool mounted in its own native dialog and preserve draft/scan state across close and reopen.
- [x] Close artwork detail before opening a tool; close Collections after selecting a scope.
- [x] Invalidate stale restore navigation on tool dismissal, a newer request, filter or scope changes, and session expiry.
- [x] Keep contact sheet controls with gallery results and retain upload/detail/viewer behavior.
- [x] Add responsive dialog styling and remove redundant Collection/Trash accordion toggles.
- [ ] Review the final diff for focus, scroll-lock, session, and async ownership edge cases. Fix any reproducible issue in the owning component.
- [ ] Check 320 px and 390 px mobile layouts, a desktop layout, dialog content scrolling, touch targets, and horizontal overflow.
- [ ] Exercise keyboard entry, Tab and Shift+Tab boundaries, Escape, Close, and focus return for all five tools. Check that background controls cannot receive focus while a dialog is open.
- [ ] Exercise date drafts and Apply/Clear, tag selection, collection selection, Trash confirmation, upload while closing a tool, and contact sheet selection after a scope change.
- [ ] Exercise health scan persistence across close/reopen, successful and failed health-to-detail lookup, stale lookup cancellation, and return focus after closing the detail dialog. Verify notification cooldown survives close/reopen.
- [ ] Run focused integration suites, typecheck, lint on changed files, production build, and `git diff --check`. Record actual results here before committing.

## Acceptance checks

1. On desktop and narrow mobile, the gallery is reachable below the compact toolbar without horizontal overflow. Search, applied scope, artwork count, and contact sheet selection remain discoverable.
2. Exactly one tool dialog is modal at a time. Escape and Close dismiss it; focus returns to its trigger; body scrolling resumes. Keyboard focus stays inside the open dialog.
3. Filter drafts, active scan, and notification cooldown survive closing and reopening their tools. Applied filters, collection scope, pagination, and selected contact sheet items remain consistent after changes.
4. A health result opens the intended detail only after a successful current lookup. A failed or superseded lookup does not open stale detail or silently close the health dialog.
5. Upload, artwork detail/viewer, Trash mutations, and collection operations retain their current error and confirmation behavior. Logout or session expiry clears sensitive UI state.

## Verification log

| Check | Result |
| --- | --- |
| `npm run typecheck` on 2026-10-28 | Passed. |
| `npx vitest run tests/integration/gallery-tools.test.ts tests/integration/accessibility-performance.test.ts` on 2026-10-28 | 2 files, 9 tests passed. |
| `git diff --check` on 2026-10-28 | Passed before adding this plan. |
| Earlier focused frontend regression run | 7 suites, 58 tests passed; rerun after any fixes. |
| Earlier local browser check | Five tools opened as native modal dialogs; Escape, focus return, and body scroll restoration worked at the tested desktop size. |
| Mobile, keyboard boundaries, async handoff, production build | Pending. |

The earlier automated date-input interaction did not populate the fields. It did not establish an application defect or a passing date-filter check. Recheck with visible input state and an applied gallery result.

## Finish

After the unchecked acceptance paths pass, update this log with commands, viewport sizes, failures and fixes. Review the diff, then commit the plan and implementation together if committing is requested. Push and deploy require their own release decision. The optional process gallery remains outside this work.
