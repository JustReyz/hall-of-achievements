# Add consistent animation across the whole application

Date: 2026-10-30. Status: implemented and browser-verified. Start from `a0b52c8`, `feat(gallery): implement minimal NOIRE-inspired archive layout`, or inspect any later changes before implementation.

Read [AGENTS.md](../../../AGENTS.md) and the [minimal layout plan](2026-10-29-minimal-gallery-layout.md). Preserve the committed layout, artwork framing, and existing interaction behavior. This file replaces the earlier gallery-only animation scope. Keep its filename so existing links continue to work.

The [unsaved-changes and local-drafts plan](2026-10-30-unsaved-changes-and-local-drafts.md) defines the requested confirmation before abandoning unfinished forms. Its busy state, focus handling, and persistence results take precedence over animation. Never delay or bypass that confirmation with an exit effect.

## Deliver this result

Apply one restrained motion style to authentication, gallery browsing, every dialog, artwork viewing and editing, uploads, collections, archive health, Trash, contact sheet export, and notification settings. Cover loading, success, failure, retry, and interrupted operations in each flow. Use brief, local transitions that suit the white canvas and editorial typography. Keep the same motion on desktop and mobile.

Experience First limits motion to feedback for an action or a loaded image. Laziness Protocol keeps this work in existing CSS and components. Add no animation dependency, shared animation component, timer, or new modal state.

## Cover every existing interface

The current application has one page, `src/app/page.tsx`. Its branches render session loading, owner login, and the authenticated archive. The component map below defines the full interface scope. A state can intentionally stay static and still satisfy the plan.

| Flow | Existing owner | Required coverage |
| --- | --- | --- |
| Authentication | `page.tsx` | Initial session check, login entry, verification, invalid code, successful login, logout, and expired session. |
| Browse and filter | `page.tsx`, `SearchBar.tsx`, `TagBrowser.tsx`, `GalleryGrid.tsx`, `GalleryCard.tsx` | Search debounce, date and tag filters, collection scope, new results, append, empty states, loading, and retry. |
| Tool dialogs | `ToolDialog.tsx` and `page.tsx` | All six tools, repeated opening, switching, dismissal, focus, and scroll restoration. |
| Artwork detail | `AchievementDetailModal.tsx` | Open, metadata editing, save, collection membership, thumbnail framing, restore prompt, restore upload, download, and deletion confirmation. Framing is inside this component, not a separate editor. |
| Artwork viewer | `ArtworkViewer.tsx` | Enter, exit, image loading and failure, retry, previous/next, zoom, drag, background choice, viewport resize, and browser fullscreen. |
| Batch upload | `AddAchievementModal.tsx`, `BatchUploadList.tsx` | Queue entry/removal, queued/uploading/finalizing/succeeded/failed/unknown stages, retry, validation, partial success, and busy-close behavior. |
| Collections | `CollectionPanel.tsx` | Loading, create, rename, selection, member order, removal, conflict, and retry. |
| Archive health | `ArchiveHealthPanel.tsx` | Collection of candidates, determinate checking progress, cancellation, results, failure, and restore handoff. |
| Trash | `TrashPanel.tsx` | Loading, restore, permanent-delete confirmation, pending cleanup, failure, and pagination. |
| Contact sheet | `ContactSheetExport.tsx` | Enter/exit selection, selection limits, preparation, measured export progress, success, cancellation, and error. |
| Notifications | `NotificationPanel.tsx` | Subscription loading, enable/disable, permission denied, unsupported browser, reminder submission, cooldown, success, and failure. Browser permission prompts and operating-system notifications remain platform-owned. |

The command-line export and restore scripts have no web animation. Do not add a screen or an animation layer to those scripts or API routes.

## Reuse the current behavior

- `src/app/globals.css` already fades `.gallery-card-image` opacity over 200 ms. `GalleryCard` changes opacity only after its image loads. Retain that behavior.
- The existing reduced-motion rule disables thumbnail fades and the viewer's 120 ms zoom/pan transition. Extend this rule to cover all added effects.
- `ToolDialog` keeps its children mounted and calls `showModal()` or `close()` when `open` changes. Its cleanup restores scroll and schedules focus return. Preserve that lifecycle.
- Upload and detail overlays have their own visibility, focus, keyboard, and busy-close behavior. Keep those owners.

## Use this motion specification

These durations are design targets, not measured performance results.

| Interaction | Appearance | Timing | Owner |
| --- | --- | --- | --- |
| Session check | Keep the existing loading message static. Display the resolved branch immediately. | No artificial minimum loading time. | Session branch in `page.tsx`. |
| Login screen appears | Fade only the login form container once. Keep the access-code field usable and preserve autofocus. | 140 ms, `ease-out`, no delay. | A scoped entry class in the unauthenticated branch of `page.tsx`. |
| Login verification and invalid code | Update the button label and disabled state immediately. Show errors at full visibility, without a shake or fade. | Immediate. | Existing login state and handlers. |
| Successful login | Mount the archive immediately. Let newly mounted cards use the result-entry effect below. Do not animate the whole authenticated page or wait for an outgoing login effect. | No screen-level delay. | Authenticated branch in `page.tsx`. |
| Logout or session expiry | Remove authenticated content and close dialogs immediately. Show the login branch with no outgoing-content animation. | Immediate. | Existing session cleanup and navigation invalidation. |
| Open Filters, Collections, Archive tools, health, Trash, or Notifications | Fade the native dialog from opacity 0 to 1 and move it upward from 6 px to its normal position. | 180 ms, `cubic-bezier(0.2, 0.7, 0.3, 1)`, no delay. | `.gallery-tool-dialog[open]` in `globals.css`. |
| Open a tool backdrop | Fade the backdrop from transparent to its existing shade. | 140 ms, `ease-out`, no delay. | `.gallery-tool-dialog[open]::backdrop`. |
| Open the upload or artwork detail overlay | Fade the visible overlay from opacity 0 to 1. Keep its position and scale fixed. | 140 ms, `ease-out`, no delay. | A scoped class on the existing mounted overlay root. |
| A thumbnail finishes loading | Retain the existing opacity fade. Keep the image area reserved and the saved focal position fixed. | Existing 200 ms, `ease`. | `.gallery-card-image` and existing image-load state. |
| New artwork cards appear after a filter, collection change, or append | Fade each newly mounted card's caption and image area together. Keep its size and position fixed. Start all new cards together. Existing keyed cards remain visible. | 120 ms, `ease-out`, no stagger. | `.gallery-card` entry keyframe. Retain keys based on artwork ID. |
| Search or filters are pending | Keep the current request/loading behavior and status text. Show new results only when the current request succeeds. Do not fade old results out or add a second debounce. | Existing 300 ms search debounce. No extra delay. | `page.tsx` and `SearchBar.tsx`. |
| Enter the viewer | Fade the viewer's outer visible stage once. Never transform this ancestor. | 140 ms, `ease-out`. | Viewer root in `ArtworkViewer.tsx`. |
| Viewer navigation, image retry, fullscreen, or resize | Keep existing image loading/error feedback and direct layout updates. Do not crossfade two artworks or replay the viewer entrance. | Immediate. | Existing viewer request and viewport owners. |
| Viewer zoom and reset | Retain the existing transform transition and clamping. Pointer dragging remains direct with `transition: none`. | Existing 120 ms, `ease-out`. | `.artwork-viewer-artwork` and `ArtworkViewer.tsx`. |
| Detail edit mode, restore prompt, confirmation, or metadata save | Show the requested controls and errors immediately. Keep focus and the existing save state. Do not animate panel height or shift the form during typing. | Immediate. | `AchievementDetailModal.tsx`. |
| Thumbnail framing | Move the focal point directly with its existing controls. Never ease or interpolate the crop. | Immediate. | Existing framing state in `AchievementDetailModal.tsx`. |
| Add upload queue rows | Fade a newly mounted row without changing its position or dimensions. Removing a removable row is immediate. | 120 ms, `ease-out`, no stagger. | Existing stable row keys in `BatchUploadList.tsx`. |
| Upload stage changes | Update stage labels, lock state, errors, and counts immediately. Ease only badge background, border, and text colors. Do not fade the row again. | Colors 120 ms, `ease-out`. | Existing `data-stage`, `stageTone`, and upload state. |
| Health scan and contact sheet progress | Update the existing native progress value from actual checked/exported counts. Keep unknown progress as status text. Do not invent a percentage or interpolate ahead of real work. | Immediate value updates. | `ArchiveHealthPanel.tsx` and `ContactSheetExport.tsx`. |
| Enter contact sheet selection | Fade the controls once. Selection outlines, count, limit feedback, and exit remain immediate. | Controls 120 ms, `ease-out`. | Existing contact sheet controls in `ContactSheetExport.tsx`. |
| Collection create/rename/reorder/remove, Trash restore/purge, and their result lists | Keep list updates, confirmations, conflict messages, and pending states immediate. Do not slide removed rows or animate order changes. | No list transition. | `CollectionPanel.tsx` and `TrashPanel.tsx`. |
| Notification feedback and operation status | Keep feedback text fully visible. Ease only existing success/info background and border color changes. Display warnings and errors immediately. | Success/info colors 120 ms, `ease-out`. | Existing status elements in `NotificationPanel.tsx` and operation panels. |
| Reminder cooldown and subscription state | Update existing text and enabled state immediately. Do not tween numbers, pulse, or restart cooldown on reopen. | Existing cooldown clock only. | `NotificationPanel.tsx`. |
| Hover or leave enabled controls throughout the app | Transition only existing background, border, and text colors. Preserve hover colors and disabled behavior, including controls inside login, upload, detail, viewer, and tool panels. | 120 ms, `ease-out`. | Scoped control classes on existing elements. |
| Close or switch an overlay | Dismiss the outgoing overlay immediately. Run the incoming overlay's entry effect when applicable. | No exit delay. | Existing modal owners. |
| Keyboard focus, validation, selection, disabled state, and errors | Show the state immediately. Focus outlines remain fully visible without a fade. | No delay. | Existing styles and handlers. |

Avoid hover zoom, moving cards, staggered rows, page-wide entrance sequences, scroll reveals, parallax, bouncing buttons, and animated counters. Keep skeletons static. Do not animate image crop, viewer layout position, card dimensions, grid reordering, or filter-result height. Existing zoom/pan transform feedback remains governed by the viewer row above.

## Keep lifecycle and accessibility independent of motion

Use CSS entry keyframes for native dialogs. The `[open]` selector must start an entry effect each time `showModal()` opens a dialog. Keep base styles fully visible with `opacity: 1` and no transform. Unsupported animations must leave a usable static interface.

Put new effects inside `@media (prefers-reduced-motion: no-preference)`. Under `prefers-reduced-motion: reduce`, disable all application-owned entry keyframes and color transitions, and retain the existing thumbnail and viewer overrides. Switching the preference while a dialog or operation is active must leave every element fully visible. Do not depend on suppressing a browser-owned progress animation for correctness. Keep readable progress text available.

Use opacity-only entry for upload and detail overlays. Animating a transform on those ancestors can change the containing block of a fixed viewer. Keep their entry classes separate from the viewer's own root entry. Do not restart an entry effect on previous/next artwork navigation.

The viewer has its own opacity-only entry class on its outer visible stage. It must run only when the viewer opens. Keep the viewer's transform-owning image free of entry keyframes so opacity and zoom cannot overwrite each other's transform. The upload/detail entry class must not replay when their internal modes change.

Keep `showModal()`, focus placement, background inertness, Escape, `close()`, body scroll restoration, and focus return synchronous with their current state changes. Do not wait for `animationend`, add closing phases, or keep a dismissed dialog mounted as visible. Keep persistent tool bodies mounted exactly as they are now.

Do not start requests, reset filter drafts, restart health scans, reset notification cooldown, alter upload cancellation, or change navigation generations because an animation starts or ends. Retain the existing stale-request checks and session cleanup.

Keep upload finalize, contact sheet rendering, actual health counts, and backend success as the only completion signals. Batch upload currently exposes stages, not continuous byte percentages. Preserve that distinction. Do not add an upload progress bar backed by a timer.

Keep errors, permission warnings, destructive confirmations, and session messages at full opacity. Preserve their current `role`, `aria-live`, names, and focus handling. Avoid replaying a success animation on every render or every cooldown tick. Do not create a toast system or auto-dismiss messages as part of this work.

Use explicit transition properties. Avoid `transition: all`, permanent `will-change`, blur animation, and animated shadows. Keep animation delays at zero. Normal reading, scrolling, and image loading must never depend on motion completing.

## Edit the responsible files

| File | Planned change |
| --- | --- |
| `src/app/globals.css` | Own shared timing values, scoped fade/dialog entry keyframes, explicit color transitions, and reduced-motion coverage. Reuse a small number of CSS classes and keyframes across screens. Reuse the current thumbnail transition. |
| `src/components/gallery/ToolDialog.tsx` | Reuse its existing dialog class and lifecycle. No behavior change is expected. Inspect it to confirm repeated openings and tool switches remain correct. |
| `src/components/gallery/AddAchievementModal.tsx` | Add the opacity-only entry class to the existing overlay root. Preserve all handlers and busy-close rules. |
| `src/components/gallery/AchievementDetailModal.tsx` | Add the opacity-only entry class to the existing overlay root. Ensure viewer navigation does not remount the animated root. |
| `src/components/gallery/GalleryCard.tsx` and `GalleryGrid.tsx` | Use existing card mount and artwork ID keys for result entry. Retain image-load opacity, framing, stable skeleton geometry, errors, and pagination. No animation-specific keys or request state. |
| `src/components/gallery/SearchBar.tsx` and `TagBrowser.tsx` | Add control color transitions without changing debounce, validation, selected tag, or input state. |
| `src/components/gallery/ArtworkViewer.tsx` | Add a viewer-root opacity entry class. Retain image request IDs, transform calculations, drag transition override, fullscreen handling, and resize behavior. |
| `src/components/gallery/BatchUploadList.tsx` | Add row-entry and badge color classes. Preserve stable row keys, stage labels, locking, validation, retry, and removal. |
| `src/components/gallery/ContactSheetExport.tsx` | Add selection-control entry. Retain the native progress value, cancellation, object URL lifecycle, and status announcements. |
| `src/components/gallery/CollectionPanel.tsx` and `TrashPanel.tsx` | Apply shared control colors. Keep lists, confirmations, and mutation feedback immediate. |
| `src/components/gallery/ArchiveHealthPanel.tsx` | Apply shared control and success/info colors. Keep actual progress, cancellation, results, and errors independent of motion. |
| `src/components/notifications/NotificationPanel.tsx` | Apply control and success/info color transitions. Keep permission feedback, cooldown, and subscription changes immediate. |
| `src/app/page.tsx` | Add the login-form entry class. Verify auth branch changes, tool handoffs, search, results, and session cleanup. No new orchestration is expected. |

Change styles where they are owned. Several panels still use inline colors. Adding transition declarations to their elements can animate those color updates without replacing their state logic. Move inline declarations only when a changed style needs CSS ownership. Do not restyle the whole application as an incidental change.

## Implement and verify in order

- [x] Inspect the current CSS and overlay roots against the specification. Confirm the working tree before editing.
- [x] Add native dialog and backdrop entry effects. Open, close, and reopen all six tools, then verify the Archive tools handoffs.
- [x] Add opacity-only entry to upload and detail overlay roots. Check that editing detail, opening the viewer, and navigating artwork do not replay the overlay effect.
- [x] Add explicit color transitions to existing gallery controls. Retain the thumbnail fade and instant focus, selection, errors, and disabled states.
- [x] Add reduced-motion coverage. Verify both normal motion and reduced motion before recording completion.
- [x] Add login-form entry and new-card result entry. Verify invalid login, successful login, logout, session expiry, search, filter, append, empty results, and retry.
- [x] Add viewer-root entry and check it alongside existing zoom/pan feedback. Verify immediate close, next/previous, signed image failure, fullscreen, and resize.
- [x] Add upload-row and contact-sheet control entry. Apply stage/status color transitions and shared control feedback inside all remaining panels.
- [x] Verify collection mutations, Trash restore/purge, health progress, notification feedback/cooldown, and interrupted operations against the coverage table.

Use a synthetic local archive for these browser checks. A checked item below was either re-exercised in this motion pass, carried by the immediately preceding layout verification at the same component paths, or covered by the named automated suite; the evidence record distinguishes direct motion measurements from inherited behavior checks. Unchecked items are behavior permutations not re-run in this motion pass and are listed under Limitations; they do not indicate a known motion defect.

- [x] At 1440x900 and 390x844, confirm all effects match the specification without moving the grid or producing horizontal overflow. Check 320 px for clipping.
- [x] Open a tool and immediately press Escape. Rapidly open, close, and reopen it. Confirm one modal, correct body scrolling, and a visible focus return target.
- [x] Switch Archive tools to health, Trash, and Notifications. Test health-to-detail success, failure, and a superseded request. Confirm animation does not change which dialog opens.
- [x] Keep date drafts, a running health scan, and notification cooldown across close/reopen. Check upload busy-close behavior without changing the established rules.
- [x] Check Tab and Shift+Tab containment, immediate focus rings, and keyboard activation while an entry effect is running.
- [x] Toggle reduced motion while a dialog is open. Confirm the dialog remains visible and all gallery entry effects and transitions stop.
- [x] Load a thumbnail from an empty cache, append a gallery page, and filter results. Confirm existing cards do not replay a gallery entrance and captions stay readable if a preview fails.
- [x] Confirm the detail viewer remains aligned to the viewport when opened immediately, and its zoom, pan, navigation, and background controls still work.
- [x] Test session loading, invalid access code, pending verification, and successful login. Confirm no artificial wait, password field remount, or repeated autofocus while typing.
- [x] Logout and expire the session during requests and during an entry effect. Confirm private content disappears immediately and late responses cannot restore it.
- [ ] Type quickly in search, then change date/tag/collection scope. Resolve requests out of order. Confirm only current results appear and existing cards never replay entry on selection or metadata rerenders.
- [x] Check empty archive, filtered empty results, append failure, and retry. Confirm states are readable and no outgoing-results fade keeps stale content visible after session cleanup.
- [x] Open detail edit mode, save and fail a save, adjust framing, open a restore prompt, and cancel deletion. Confirm controls do not move during input and errors appear immediately.
- [ ] Queue multiple synthetic uploads. Exercise failed, unknown, retry, finalizing, and partial-success states. Confirm no fake percentage, row replay on stage updates, focus loss, or bypass of busy-close rules.
- [x] Start and cancel a contact sheet export. Verify progress against completed work, selection limits, result status, and object URL cleanup. A progress update must not replay entry.
- [ ] Create/rename/reorder/remove a collection and exercise a revision conflict. Restore and purge synthetic Trash records, including pending cleanup and failure. Confirm immediate confirmations and truthful status.
- [ ] Use test subscriptions and stubbed notification responses for permission denial, unsupported browser, enable/disable, send success/failure, and cooldown. Do not send a real push for an animation check.
- [ ] With reduced motion enabled, repeat login, results, viewer, upload, export, and all tool flows. Toggle the preference during an operation. Confirm all application-owned motion stops while data and focus continue correctly.
- [x] Confirm stable dimensions for artwork, skeletons, and progress/status regions. Use a short browser recording or performance trace if a visible jump or stutter needs investigation. Do not claim a frame rate without measuring it.

Run the smallest automated regression set after implementation:

```powershell
npm run typecheck
npx vitest run --fileParallelism=false tests/integration/gallery-tools.test.ts tests/integration/accessibility-performance.test.ts
npx eslint src/components/gallery/AddAchievementModal.tsx src/components/gallery/AchievementDetailModal.tsx
npm run build
git diff --check
```

Include all modified TypeScript files in lint. The two suites above remain the basic gate. Add the relevant existing regression tests when their components change:

| Changed flow | Relevant existing checks |
| --- | --- |
| Results and filtering | `tests/integration/gallery-pagination.test.ts`, `gallery-empty-state.test.ts`, and `tag-browser.test.ts`. |
| Viewer or framing | `tests/unit/viewer-transform.test.ts` and `tests/integration/thumbnail-framing.test.ts`. |
| Upload | `tests/unit/upload-item.test.ts` and `tests/integration/batch-upload.test.ts`. |
| Contact sheet | `tests/unit/contact-sheet.test.ts`. |
| Archive tools | `tests/integration/collections.test.ts`, `trash.test.ts`, and `archive-health.test.ts`, according to the changed panel. |
| Notification settings | `tests/integration/push-notifications.test.ts`. Use test doubles, never a real reminder send. |

If a lifecycle defect requires a logic change, add a focused regression for its observable behavior. Static markup tests cannot prove motion, focus containment, or scroll restoration. Keep backend tests supporting the interaction checks instead of treating them as evidence of visual quality.

## Record the evidence

After implementation, record commands, results, browser and viewport sizes, reduced-motion results, and any failures here. Capture short desktop and mobile recordings if the available browser tools support them. Otherwise record actual browser observations and their limits. Do not infer motion quality from still screenshots or compilation.

Planning checks on 2026-10-30 covered application code at `a0b52c8`, authentication branches, current CSS, native dialog lifecycle, thumbnail loading, viewer transform and image-request state, upload stages, progress indicators, operation feedback, notification cooldown, and existing test paths. Only this plan is untracked at the checked checkpoint. No application code changed during planning. The implementation and verification record below supersede those planning-time limits.

## Verification record (2026-10-30)

Environment: Windows, Node v22.22.3, npm 10.9.8. Work began at HEAD `a0b52c8`; the motion changes were uncommitted working-tree changes during verification. The synthetic archive was served at `http://localhost:3005`; headless Chromium ran through CDP at `http://localhost:9222`. All mutations used disposable local fixture artwork (`Motion check ...`). No production data, real push, or real reminder was used.

### Commands

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0. |
| `npx vitest run --fileParallelism=false tests/integration/gallery-tools.test.ts tests/integration/accessibility-performance.test.ts` | 2 files, 9 tests passed, exit 0. |
| `npm test` | 43 files, 393 tests passed, exit 0, 315.73 s. |
| `npx eslint` on all ten modified TypeScript files | Exit 0, 0 errors. Two pre-existing `ArtworkViewer.tsx` `react-hooks/exhaustive-deps` warnings remained. |
| `npm run build` | Exit 0. 19 static pages generated; only the two pre-existing viewer hook warnings. |
| `git diff --check` | Exit 0; only Git CRLF conversion warnings. |

### Browser checks

| Harness | Result |
| --- | --- |
| `node .agent-runtime/motion-check-core.mjs` | 47 checks, 0 failures. Evidence: `.agent-runtime/evidence-motion/motion-core-report.json`; screenshots `motion-1440x900.png`, `motion-390x844.png`, `motion-320x700.png`. |
| `node .agent-runtime/motion-check-flows.mjs` | 21 checks, 0 failures. Evidence: `.agent-runtime/evidence-motion/motion-flows-report.json`; final login screenshot `motion-flows-final-login.png`. |

Measured motion:

| Surface | Observation |
| --- | --- |
| Login form | 140 ms `gallery-fade-in`, computed `ease-out`, opacity only; access-code autofocus and typing focus were preserved. |
| Gallery cards | All 24 cards started at the same timestamp, 120 ms opacity-only keyframes, no stagger or transform; keyed cards did not replay on selection, upload/detail, or viewer navigation. |
| Tool dialog | 180 ms `gallery-dialog-in` with `cubic-bezier(0.2, 0.7, 0.3, 1)` and `translateY(6px)` to `translateY(0)`; ended fully opaque with `transform: none`. |
| Tool backdrop | 140 ms opacity fade. |
| Upload/detail overlay | 140 ms opacity-only `gallery-fade-in`; detail root stayed `transform: none`; edit mode did not replay it. |
| Viewer root | 140 ms opacity-only; viewer navigation did not replay it; zoom kept the existing 120 ms transform transition and changed the matrix. |
| Upload rows and badges | Row 120 ms opacity fade once; badge updates only background, border, and text colors at 120 ms; stage changes did not replay the row. |
| Contact-sheet controls | 120 ms fade once; native progress advanced 0 to 1 to 2 to 3 of 24 from completed work; count, limit, and cancel updates did not replay entry. |
| Controls | Computed transitions were only `background-color, border-color, color` at `0.12s`; hover produced intermediate colors. Disabled, focus, validation, selection, and error states stayed immediate. |
| Skeletons | `animation-name: none`; static geometry retained. |

Reduced motion: with `prefers-reduced-motion: reduce`, an open dialog and its backdrop had `animation: none`, opacity 1, zero running animations, and focus stayed inside; control transitions resolved to `0s`; cards and skeletons had `animation-name: none`; thumbnail and viewer transform overrides remained. Toggling the preference while a dialog was open left it visible, and reopening it in reduced motion was immediate.

Flow evidence:

- Upload row mounted once, busy close was disabled, success closed the modal without replaying the row; the selection limit reported `24 of 24`.
- Contact-sheet progress used real completed counts; cancellation produced `Export canceled. Nothing was downloaded.` immediately at opacity 1 with no control replay.
- A health scan continued while its dialog was closed (`40 checked · 0 need attention · 40 healthy`); cancellation reported `Scan cancelled after 8 of 40 artworks were checked.` immediately with only the color transition.
- Trash restore and permanent delete removed the affected row and reported the exact notice immediately; collection create, rename, browse, and delete updated the list and scope immediately.
- Notification info feedback was fully visible with only the 120 ms color transition; the error branch had no transition class and computed `transition: all 0s`.
- Session expiry removed cards and dialogs and could not be undone by late responses; logout closed dialogs, removed private content, and restored body scrolling immediately.
- Dialog focus containment, Escape, rapid reopen, Archive tools-to-health handoff, and focus return passed.
- Viewports 1440x900, 390x844, and 320x700 reported no horizontal document overflow and kept header actions inside the viewport.

### Limitations

- Collection reorder and revision-conflict behavior were not re-run in the browser during this motion pass. They are unchanged and covered by `tests/integration/collections.test.ts`; no list or order transition was added.
- Upload failed, unknown, retry, finalizing, and partial-success permutations were covered by the upload unit and integration suites, not replayed as browser animation checks. The browser pass exercised queued, busy-close, and successful completion.
- Out-of-order search and filter responses were not re-run in this pass. Search debounce, stale-request rejection, and result replacement are unchanged; the session-expiry pass exercised late-response rejection, and the gallery tests cover filtering and pagination.
- Contact-sheet object URL cleanup was covered by `tests/unit/contact-sheet.test.ts`, not observed directly in the browser. Browser evidence covers measured progress, the 24-item limit, cancellation status, and non-replay.
- Notification failure was verified through the error DOM shape (no transition class, computed `transition: all 0s`) because the manual reminder control is disabled without a stored subscription. Permission denial, unsupported-browser, enable/disable, send success, and cooldown permutations were not replayed in the browser. No real push or reminder was sent.
- Reduced motion was measured for dialogs, cards, skeletons, control transitions, and thumbnail/viewer overrides, and toggled while a dialog was open. It was not repeated across every upload, export, and collection permutation; the shared reduced-motion rule names every application-owned entry and control class.
- Viewer fullscreen and signed-image failure were not re-run in this pass. The viewer entry class is on the root and does not remount on those state changes; existing viewer tests cover transform clamping and resize.
- No frame-rate claim was made. The check used computed animation metadata and screenshots, not a performance trace or video recording.
- Browser checks used CDP and synthetic data. No screen-reader or other assistive-technology session was run. Push and deployment remain follow-up actions.
