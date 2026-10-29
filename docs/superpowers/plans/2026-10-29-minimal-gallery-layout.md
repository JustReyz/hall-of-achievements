# Implement a minimal gallery layout inspired by NOIRE

Date: 2026-10-29. Status: implemented and verified against a synthetic local archive. Commit, push, and deployment remain follow-up actions.

## Start from the verified repository state

Read [AGENTS.md](../../../AGENTS.md). Continue from the current working tree and preserve unrelated edits.

The repository was fetched and pulled with `git pull --ff-only origin main` on 2026-10-29. Git reported `Already up to date.` Both `HEAD` and `origin/main` point to `133c9769c17318386b9750b317ce4d38306bdc9e`, `docs: record the phase 8 checkpoint`. That commit adds `docs/CONTINUE-HERE.md`. There are no incoming commits and no committed diff between local and remote `main` at this checkpoint.

There is an existing, uncommitted overlay implementation. `git diff --stat` reports seven tracked files with 470 insertions and 297 deletions. That statistic excludes untracked files. Inspect both groups before editing.

| Existing local work | Continue with this work |
| --- | --- |
| `src/app/page.tsx` | Compact toolbar, one `GalleryTool` union, five persistent dialogs, scope summary, and navigation invalidation. |
| `src/app/globals.css` | Gallery and responsive dialog styles. Refine these rules instead of adding a second competing theme. |
| `src/components/gallery/ToolDialog.tsx`, untracked | Native dialog lifecycle, Escape, scroll lock, and focus restoration. |
| `AchievementDetailModal.tsx` | Keyboard listener guard when no artwork is selected. |
| `CollectionPanel.tsx` and `TrashPanel.tsx` | Removed redundant accordion controls inside tool dialogs. |
| `ArchiveHealthPanel.tsx` | Explains that checks can continue while the tool is closed. |
| `tests/integration/accessibility-performance.test.ts` | Corrected stale assertions for the upload modal's keyboard handler. |
| `tests/integration/gallery-tools.test.ts`, untracked | Dialog name, retained body, and closed markup check. This does not prove browser focus behavior. |

This plan supersedes the visual layout in the [2026-10-28 overlay plan](2026-10-28-gallery-overlay-ui.md). Retain that plan's verification history and unfinished interaction checks. Its history is not proof that this new layout passes.

## Use the reference to set the visual direction

Review the owner's current-layout screenshot in the conversation and [NOIRE Art Gallery Landingpage](https://dribbble.com/shots/26959619-NOIRE-Art-Gallery-Landingpage). The [supplied reference image](https://cdn.dribbble.com/userupload/46306126/file/eff70c4bf314cd862f22eea5027f98fd.png?resize=1504x1128&vertical=center) was downloaded and inspected for this plan.

Adapt the reference's white canvas, dark green type, editorial serif headings, thin borders, generous spacing, and large artwork. Keep the product name Hall of Achievements and the owner's artwork. The reference is design evidence, not an application image asset.

Build a private archive screen. Keep the artwork grid near the top. Use a short collection heading instead of the reference's full-height promotional hero. Leave exhibition marketing, decorative paintings, social links, FAQ sections, carousels, and public navigation outside this task.

## Build this default screen

Use this hierarchy at desktop widths. The diagram represents layout, not exact text widths.

```text
Hall of Achievements                       + Add artwork   Archive tools
Private art archive
------------------------------------------------------------------------

Your collection                                      8 artworks loaded

[ Search artwork or #tags........................ ] [ Filters ] [ Collections ]
[ Applied collection or date or tag, only when active ]

[                 artwork                 ]  [ artwork ]  [ artwork ]
Artwork title                                ...          ...
Completion date

[                 artwork                 ]  [ artwork ]  [ artwork ]

                              Load more artwork
```

- Keep the header in normal document flow. Use the product wordmark, a small subtitle, one filled **Add artwork** button, and a quiet **Archive tools** button. Remove the decorative emoji badge from this screen.
- Use **Your collection** as the short serif heading. Keep the loaded count as a factual status, not a total archive count. Preserve collection context when a collection is selected.
- Keep search visible. Place **Filters** and **Collections** beside it on desktop. Move the five-button local toolbar to the control structure below.
- Render applied scope only when a collection, date bound, or tag is active. Omit default labels such as `Any date` and `All tags`. Keep search text in the search field.
- Show artwork immediately after the toolbar and any applied scope. Remove the full-width tag browser and management panels from the default document flow.
- Give cards a plain image area and a caption below. Show the title and completion date. Put the full tag list in the existing detail view and Filters dialog, removing tag chips from the card preview.
- Keep contact sheet controls beside the grid only while selection mode is active.

## Place every existing action

| Entry point | Contents and behavior |
| --- | --- |
| **Add artwork** in the header | Open the existing `AddAchievementModal`. Retain batch progress, validation, retry, quota checks, and busy-close behavior. |
| **Filters** beside search | Open the existing persistent date and tag tool. Retain Apply dates, Clear dates, validation, and the existing tag facet. Keep the tool open while the owner adjusts filters. |
| **Collections** beside search | Open `CollectionPanel`. Preserve create, rename, ordering, removal, and selection. Selecting a collection returns to the gallery. |
| **Archive tools** in the header | Open a small native dialog containing storage usage, launch buttons for Archive health, Trash, and Notifications, **Select for contact sheet**, and **Log out**. |
| **Archive health**, **Trash**, or **Notifications** inside Archive tools | Replace the launcher with the corresponding persistent tool dialog. Keep exactly one active tool. Closing the destination returns to the gallery and focuses the header's Archive tools button. |
| **Select for contact sheet** inside Archive tools | Close the tool, then enable the existing gallery selection mode. Retain the 24-item limit, loaded-item semantics, export, clear, and exit actions. Focus a visible selection control. |
| Storage usage | Move normal usage into Archive tools. Retain the existing above-80-percent warning threshold and expose that warning visibly on the header trigger. Announce the warning without relying on color. |
| **Log out** inside Archive tools | Use the existing logout handler. Preserve failure reporting and session cleanup. |
| Artwork card | Open the existing detail and viewer workflows with edit, restore, collections, download, and Trash actions. |

Do not use a custom ARIA menu for Archive tools. Its mixed content fits the existing native dialog. Keep destructive confirmations inside their responsible panels.

## Apply a small set of visual rules

Use these values as implementation targets. Verify contrast and responsive geometry in the browser.

| Element | Target |
| --- | --- |
| Canvas | White or warm white `#fcfcfa`. Avoid alternating dashboard panels. |
| Main text | Deep green `#143d36`. Use `#53645e` for secondary text and `#d9dfdb` for borders. |
| Typography | System sans serif for controls and metadata. Use `Georgia, 'Times New Roman', serif` for the collection heading and artwork titles. Add no remote font request. |
| Type sizes | Wordmark 20 to 24 px. Collection heading 36 px desktop and 28 px mobile. Card title 20 px. Controls 14 px. Metadata 13 px. |
| Content | Maximum width 1320 px. Use 48 px outer gutters on wide screens, 24 px on tablets, and 20 px on mobile. |
| Spacing | Use 8, 12, 16, 24, 32, and 48 px intervals. Keep heading and toolbar spacing compact enough to meet the first-row acceptance check. |
| Controls | Minimum 44 px touch height. Filled dark green for the primary action. Quiet text or thin outlined secondary controls. Corners 2 to 4 px. |
| Cards | Remove enclosing borders, raised shadows, and hover translation. Preserve a strong keyboard focus outline. Retain the current 4:3 image area, `object-fit: cover`, and saved focal position. |
| Grid | Three columns at 960 px and above, two at 600 to 959 px, and one below 600 px. Use 24 px column gaps and 32 px row gaps. Match skeleton dimensions to cards. |
| Dialogs | Use the existing native dialog with a subtle backdrop, thin border, restrained corners, visible Close action, and scrollable content. Preserve independent viewer background choices. |

Use one column on small phones so artwork stays large. Let the mobile header wrap the brand above its two actions when needed. Make search full-width with Filters and Collections on the next row. Keep all controls reachable at 320 px and at 200-percent zoom.

## Preserve ownership and async behavior

Keep `HomePage` as the owner of applied filters, selected collection, pagination, selected artwork, and request generations. Extend the existing tool shape with `'archive'` so `GalleryTool | null` also represents the launcher. Keep tool bodies mounted while authenticated. Closing a tool must preserve draft filters, notification cooldown, and a running health scan.

Reuse `openTool`, `closeTool`, `closeDetail`, and the existing navigation generation checks. Keep successful health-to-detail lookup, failed lookup feedback, and stale-response rejection. Opening a tool closes detail. Session expiry clears the active tool and sensitive page state.

Fix focus ownership across the new launcher handoff. `ToolDialog` currently captures `document.activeElement` and checks only `isConnected` before restoring focus. A launcher button inside a closed dialog remains connected but cannot receive focus. Record the visible initiating control in `HomePage` and let `ToolDialog` use that explicit return target when tools switch. Restore focus on final dismissal without stealing focus from a newly opened tool or detail dialog. Verify body scroll locking through the same transitions.

Keep signed thumbnail requests, lazy loading, preview failure feedback, saved framing, keyboard card activation, and contact sheet checkboxes in `GalleryCard`. Keep SearchBar's label, clear action, and 300-millisecond debounce. Preserve collection scope and existing selection resets after filter, collection, archive, or session changes.

## Edit the files that own the styles

1. Edit `src/app/page.tsx` for the header, Archive tools launcher, tool entry points, conditional scope, contact sheet entry, and focus target ownership.
2. Edit `src/app/globals.css` for scoped gallery colors, typography, responsive grid, controls, captions, and dialogs. Consolidate the existing local gallery rules.
3. Edit `src/components/gallery/GalleryCard.tsx` for the image-and-caption layout. Replace the changed inline styles and pointer style mutations with scoped CSS classes.
4. Edit `src/components/gallery/GalleryGrid.tsx` for explicit grid breakpoints, matching skeletons, empty states, and pagination appearance.
5. Edit `src/components/gallery/SearchBar.tsx` for scoped dimensions and focus styling. Keep its existing search behavior and mounted state.
6. Extend `src/components/gallery/ToolDialog.tsx` only for the visible focus target and handoff behavior the launcher needs. Retain its native modal lifecycle.
7. Adjust the existing panels' visual styles only where their outer layout clashes with the new dialog. Preserve their operation handlers.

Inspect `src/app/layout.tsx` before changing font inheritance. Its body has an inline system font. Prefer scoped serif headings to a global font replacement. Avoid adding more `!important` overrides to defeat component styles.

No data migration, API contract change, new dependency, theme switcher, or new product feature is needed for this layout.

## Implement in this order

- [x] Capture a baseline screenshot of the local working tree with synthetic artwork at 1440x900 and 390x844. Record the commit and local diff.
- [x] Build the compact shell and Archive tools launcher. Verify that every action in the action table remains reachable.
- [x] Complete tool-to-tool and health-to-detail focus handoffs. Check Escape, Close, focus containment, and scroll restoration before styling cards.
- [x] Apply the reference's type, colors, and spacing through scoped gallery styles. Replace the changed inline styles in SearchBar, GalleryCard, and GalleryGrid.
- [x] Verify default, filtered, collection, empty, loading, error, missing-preview, and contact sheet states at the specified widths.
- [x] Run the focused checks below. Fix observed failures and add a small regression test when it covers real behavior.
- [x] Record actual commands, results, viewport sizes, screenshots, and remaining limitations at the end of this file. Keep implementation checkboxes open until their checks pass.

## Verify the result

Use a synthetic local archive for mutations. Never test purge or upload against the owner's live archive.

At 1440x900, place the first artwork image within 320 px of the document top in the default authenticated view. At 390x844, place it within 400 px. These are design acceptance targets, not measurements of current code. Confirm there is no horizontal document overflow at 320, 390, 768, and 1440 px. Also check browser zoom at 200 percent.

Verify the following interactions in a real browser:

- [x] Open and close Filters, Collections, and Archive tools by keyboard. Check Tab and Shift+Tab containment, Escape, Close, focus return, and background inertness.
- [x] Switch Archive tools to each of health, Trash, and Notifications. Confirm only one native modal remains open, focus enters it, and dismissal reaches a visible header trigger.
- [x] Run a health scan, close and reopen it, and check that progress survives. Exercise successful, failed, and stale health-to-detail lookups and detail dismissal.
- [x] Enter visible date values, reopen the tool, Apply dates, Clear dates, and select a tag. Check result updates, validation, and pagination. The earlier date-input automation was inconclusive, so observe both field values and resulting artwork.
- [x] Select and manage a collection. Check ordering, scope, and contact sheet selection resets. Open contact sheet mode through Archive tools, export synthetic selections, and exit.
- [x] Check upload progress and busy-close behavior, detail editing, viewer navigation, missing-preview restore, and Trash confirmation. Keep notification cooldown across tool close/reopen without sending a real push.
- [x] Expire or end the test session during a pending request. Verify that a late response does not reopen a tool or reveal artwork.
- [x] Check long titles, many tags inside Filters, quota warnings, loading skeletons, empty results, and retry controls. Confirm captions, focus indicators, and controls have adequate contrast.

Run these commands from the repository root after implementation:

```powershell
npm run typecheck
npx vitest run --fileParallelism=false tests/integration/gallery-tools.test.ts tests/integration/accessibility-performance.test.ts tests/integration/gallery-pagination.test.ts tests/integration/gallery-empty-state.test.ts tests/integration/tag-browser.test.ts tests/integration/collections.test.ts tests/integration/trash.test.ts tests/integration/archive-health.test.ts
npx eslint src/app/page.tsx src/components/gallery/ToolDialog.tsx src/components/gallery/GalleryCard.tsx src/components/gallery/GalleryGrid.tsx src/components/gallery/SearchBar.tsx
npm run build
git diff --check
```

Include other modified TypeScript files in the lint command. Existing source-text accessibility assertions are supporting checks. They cannot establish focus containment or correct layout in a browser.

## Hand off the completed work

Provide screenshots of the default desktop view, default mobile view, Filters, and Archive tools. Summarize what changed, the checks that passed, and any unresolved behavior. Keep this plan and the earlier overlay changes together for review. Commit, push, and deployment are separate follow-up actions.

Planning verification on 2026-10-29 covered the GitHub pull, committed and local diffs, source ownership, and the supplied NOIRE image. That pass did not implement the layout or rerun browser behavior and builds. The implementation and verification record below supersede those planning-time limits.

## Verification record (2026-10-29)

Environment: Windows, Node v22.22.3, HEAD `133c9769c17318386b9750b317ce4d38306bdc9e`, local synthetic archive served from `http://localhost:3005`. All mutations used the synthetic fixture; purge and upload requests were intercepted by the browser harness.

### Commands

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0. Log: `.agent-runtime/evidence/typecheck.log`. |
| `npx vitest run --fileParallelism=false tests/integration/gallery-tools.test.ts tests/integration/accessibility-performance.test.ts tests/integration/gallery-pagination.test.ts tests/integration/gallery-empty-state.test.ts tests/integration/tag-browser.test.ts tests/integration/collections.test.ts tests/integration/trash.test.ts tests/integration/archive-health.test.ts` | 8 files, 60 tests passed, exit 0. Log: `.agent-runtime/evidence/focused-tests.log`. |
| `npx eslint` on all modified TypeScript/TSX files and both integration tests | Exit 0, 0 errors. `globals.css` produced the expected "no matching configuration" warning because it is not a lint target. Log: `.agent-runtime/evidence/eslint.log`. |
| `npm run build` | Exit 0. Only the pre-existing `ArtworkViewer.tsx` hook warnings remained. Log: `.agent-runtime/evidence/build.log`. |
| `git diff --check` | Exit 0; only CRLF conversion warnings. |

### Browser checks

Run with the dev server healthy and CDP at `http://localhost:9222`.

| Check | Result |
| --- | --- |
| `node .agent-runtime/verify-layout.mjs` | Passed. Evidence: `.agent-runtime/evidence/layout-report.json`, `layout-report.log`, and the layout screenshots below. |
| `node .agent-runtime/verify-states.mjs` | Passed. 18 boolean checks, 0 failing; 14 screenshots. Evidence: `.agent-runtime/evidence/states-report.json`, `states-report.log`. |
| `node .agent-runtime/verify-contact-sheet-entry.mjs` | Passed. Focus landed on **Select loaded**, `2 of 24 selected`, PNG downloaded (14,093 bytes), **Exit selection** restored body scroll. Log: `.agent-runtime/evidence/contact-sheet-entry-report.log`. |
| Health and tool-focus harnesses | Passed. Evidence: `.agent-runtime/evidence/tool-focus-report.log`, `health-report.json`, and `layout-health-*.png`. |

Viewport measurements:

| Viewport | First image top | Columns | Horizontal overflow |
| --- | ---: | ---: | --- |
| 1440x900 | 250 px | 3 | No |
| 768x900 | 245 px | 2 | No |
| 390x844 | 333 px | 1 | No |
| 320x800 | 357 px | 1 | No |
| 720x450 (200% zoom equivalent) | 245 px | 2 | No |

The desktop and mobile acceptance targets (320 px and 400 px respectively) pass. Canvas measured `rgb(252, 252, 250)`, primary ink `rgb(20, 61, 54)`, and headings and card titles resolve to Georgia. `#143d36` on `#fcfcfa` is approximately 11.7:1 and `#53645e` on `#fcfcfa` approximately 6.1:1; visible focus rings use the gallery ink or the existing blue outline.

Interaction evidence:

- Archive tools opened as the only native modal; focus entered the dialog; 12 forward and 12 backward Tab presses stayed inside; Escape returned focus to the header **Archive tools** trigger; body scroll was locked.
- Filters and Collections returned focus to their own triggers. Health, Trash, and Notifications each replaced the launcher, left exactly one native dialog open, focused **Close**, and returned focus to the header trigger on Escape.
- Contact-sheet entry closed Archive tools, focused **Select loaded**, and did not let the closing dialog steal focus. Selection mode, the 24-item cap, export, and exit reset behaved as before.
- Health scan progress survived close/reopen. Successful, failed, and stale health-to-detail lookups and detail dismissal passed, including returning focus to a visible target.
- Date fields, validation, Apply, Clear, tag selection, pagination, collection ordering/scope, selection resets, search debounce (first request at 308 ms), empty/loading/error states, long titles, quota warning, missing-preview feedback, Trash confirm/cancel, notification cooldown, upload busy-close, detail editing, viewer navigation, and session expiry all passed. The edit check now binds to the artwork shown after viewer navigation, so the synthetic fixture is reverted cleanly (`End`; no `After edited` remains).

Screenshots:

- Baseline: `baseline-1440x900.png`, `baseline-390x844.png`.
- Layout: `layout-1440x900.png`, `layout-390x844.png`, `layout-archive-tools.png`, `layout-filters.png`, `layout-contact-sheet.png`, `layout-zoom-200.png`.
- States: `states-filtered.png`, `states-date-filter.png`, `states-empty.png`, `states-loading.png`, `states-error.png`, `states-long-title.png`, `states-long-title-390.png`, `states-missing-preview.png`, `states-quota-warning.png`, `states-collection.png`, `states-trash.png`, `states-notifications-cooldown.png`, `states-upload-running.png`, `states-session-expired.png`.
- Health: `layout-health-results.png`, `layout-health-detail.png`, `layout-health-failure.png`.

### Limitations

- Full missing-preview re-upload was not performed. The restore handoff was exercised through the health-to-detail restore prompt and the existing automated coverage.
- Notification cooldown was verified against mocked `/api/push/subscriptions` and `/api/reminders/send` responses. No real push was sent.
- Panel internals, the login screen, and the upload modal retain their original inline blue/slate styling; only their outer dialog chrome was aligned with the new layout.
- Browser checks used CDP keyboard input and synthetic data. No screen-reader or other assistive-technology session was run.
- Commit, push, and deployment were not part of this verification and remain follow-up actions.
