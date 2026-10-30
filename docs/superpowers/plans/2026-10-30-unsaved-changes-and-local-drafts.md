# Protect unfinished forms and save local drafts

Date: 2026-10-30. Status: planned. The owner requires saved drafts to survive refresh and browser closure on the same device.

Read [AGENTS.md](../../../AGENTS.md). Start implementation from the latest `development` on a feature branch. Planning inspected `bd55277`, including the existing animation implementation. Keep this feature independent of animation completion.

## Deliver these interactions

When the owner clicks outside an upload or edited-artwork form, presses Escape, selects Cancel, or clicks Close, prevent silent data loss. If the form has unfinished work, show a confirmation with three explicit choices:

| Action | Result |
| --- | --- |
| **Continue editing** | Dismiss the confirmation and return focus to the form. Keep every field and selected file. Escape from the confirmation performs this action. |
| **Save draft** | Commit the current data and any selected files to IndexedDB. Close only after the transaction succeeds. Explain that the draft is local to this browser. |
| **Discard changes** | Remove the corresponding saved draft, if present, and discard the current form changes. Close only after required local deletion succeeds. Do not delete artwork or remote uploads. |

Use the existing English product language for these labels. Keep Continue editing as the initially focused, safe action. Clicking the confirmation backdrop must do nothing. Do not treat closing the confirmation as permission to discard.

When the form has no unfinished work, close normally. While upload, save, restore, or a draft write is pending, preserve existing busy-close protection. Do not show a choice that cannot be completed safely.

## Fix the current loss points

- `AddAchievementModal.handleClose()` currently calls `resetQueue()` before closing. Backdrop clicks, Escape, the header close action, and Cancel all reach that handler.
- `AchievementDetailModal` currently calls `onClose()` directly from backdrop clicks, Escape, and the header close action. Its edit Cancel action turns edit mode off directly. Guard those paths when metadata or framing differs from the loaded artwork.
- The detail initialization effect resets edit fields when `achievement` changes. Loading or resuming a draft must not be overwritten by that effect or an unrelated refresh.
- `ToolDialog` already ignores backdrop clicks and keeps child panels mounted. Preserve that existing protection. Collection create-name input and filter drafts already survive a tool close/reopen within the session. Do not add a warning to read-only tools or filter choices.

The first implementation covers upload queues and artwork edits, including thumbnail framing. Existing immediate collection mutations, destructive confirmations, and notification controls retain their current behavior. Collection-create persistence is not part of this draft format.

## Define unfinished work precisely

An upload queue is unfinished when at least one item has not reached `succeeded`. Selected files count as unfinished even if the owner has not edited their suggested metadata. A successful item must never be uploaded again from a recovered draft.

An artwork edit is unfinished when title, completion date, notes, normalized tag values, or thumbnail focal coordinates differ from the edit baseline. Opening edit mode without changing a value does not require confirmation. Reverting every changed field clears the unfinished condition. Use the same normalization as the existing save path without changing validation rules.

Pressing Cancel in edit mode follows the same confirmation, then leaves edit mode only after the selected action completes. Closing the whole detail dialog follows the same confirmation, then closes detail. Represent the pending destination explicitly so the confirmation does not guess which action was requested.

## Store drafts with IndexedDB

Use the browser's native IndexedDB API. It supports binary files and atomic transactions. Do not serialize files into base64 or store them in `localStorage`. Add no server draft API or new runtime dependency.

Place the storage operations and record types in `src/lib/drafts/local-drafts.ts`. Keep rendering and form state in their current components. The caller needs load, save, and delete operations; do not create a storage-provider framework.

Use a versioned database and two record kinds:

| Record | Identity and payload |
| --- | --- |
| Upload draft | One upload queue per application origin. Store stable item IDs, file bytes and filename/type/lastModified, metadata, last known stage, upload intent ID, and confirmed achievement ID when present. |
| Artwork edit draft | One record per artwork ID. Store title, date, notes, tags, focal coordinates, and the artwork's baseline `updatedAt`. |

Each record also needs a schema version, last-saved timestamp, and a revision for detecting concurrent writes. Save metadata and file bytes in the same transaction. Report success from transaction completion, not only a single request's success callback. Handle open failures, blocked upgrades, aborted transactions, unavailable storage, invalid records, and quota errors.

Validate recovered data before hydrating form state. Reuse upload file count/type/size limits and existing metadata rules. Drafts may contain incomplete fields, so distinguish an incomplete editable draft from an invalid persisted record. Never auto-upload or auto-save a recovered record to the server.

Do not persist owner access codes, cookies, signed upload/download URLs, API tokens, or derived object URLs. Local file bytes and metadata are private data stored on the device. Display this fact beside Save draft. Saving a local draft does not create an artwork or reserve server storage.

Saved drafts survive explicit logout and login because the owner requested persistence. Only load or show them after the existing owner authentication succeeds. Logout/session expiry must immediately clear in-memory private UI and hide open dialogs. Do not delay auth cleanup behind a confirmation or an IndexedDB operation. Local storage is not encrypted by this feature, and anyone with access to this browser profile may access its files.

Development and production origins have separate IndexedDB stores. Drafts do not sync between devices or domains. Browser storage eviction, private-mode restrictions, and clearing site data can remove drafts. State these limits briefly in the draft UI without promising permanent backup.

## Resume and remove drafts without surprises

When Add artwork opens and a saved upload draft exists, offer **Resume draft**, **Discard draft**, and **Start a new upload**. Do not silently overwrite the existing draft. Starting a new upload must explain that saving it replaces the single existing upload draft and require an explicit replacement choice.

When detail opens for an artwork with a saved edit, show the draft's saved time and offer Resume draft or Discard draft. Resume enters edit mode after loading the current artwork. If `updatedAt` differs from the stored baseline, explain that the artwork changed and require the owner to review the recovered edits before saving. Do not patch the server automatically or silently replace the current baseline.

If an artwork is unavailable or trashed, do not submit its draft through the normal edit route. Show that the draft cannot currently be applied and retain a way to discard it. Do not fetch original image files merely to inspect edit drafts.

After a confirmed successful artwork save or completed upload queue, remove its draft. If local cleanup fails after the server succeeded, keep the server success and report the local cleanup failure separately. A cleanup failure must not turn a successful upload into a retry that creates another artwork.

Keep a saved draft when the server rejects a save. When the owner explicitly discards an edit, reset fields to the current artwork. If IndexedDB save or delete fails, keep the current form open and intact with a retryable error.

Read and compare record revisions inside the same read/write transaction before replacing or deleting a draft. A second tab must not silently overwrite or remove a newer draft. Show a conflict and preserve the current form so the owner can choose what to keep.

## Preserve upload intent safety on recovery

Inspect every caller of `runUploadItem()` and `runUploadQueue()` before changing retry behavior. The current `runUploadItem()` requests a new intent whenever `intentId` or `uploadUrl` is missing. Restoring an intent ID without its short-lived URL through that branch can duplicate an upload whose finalize response was lost.

Recover a saved intent by checking its existing finalization outcome before requesting a replacement intent. Preserve the same intent for unknown outcomes. Request a new upload target only after the existing backend gives a definitive, compatible missing/expired/cleaned outcome. Do not convert a network failure, 401, or ambiguous 5xx into evidence that an intent can be replaced.

Reuse the current finalize endpoint and its idempotent result. Completed records remain completed even if draft cleanup failed. Persisted stages must not cause automatic network work during draft loading. An interrupted active stage needs explicit retry/reconciliation, not an assumed success or a fresh intent.

Saving or discarding a local draft does not purge remote quarantine objects. Preserve the existing expiry/cleanup rules. Warn that an already-created upload intent may still count toward quota until its normal cleanup.

## Keep confirmation accessible

Reuse the existing native dialog lifecycle through `ToolDialog` where its interface fits. Keep the unsaved-changes choice in one small shared confirmation component used by the two form owners. The form owns dirty state, the requested close destination, and pending persistence. The confirmation owns only its labelled choices and visible pending/error feedback.

Do not let the underlying upload/detail window key handlers process Escape or Tab while confirmation is active. Verify this directly; a native dialog alone does not stop the application's existing window listeners. The background form must not accept clicks or input. On Continue editing, return focus to its previous visible control. On final close, return focus to the page trigger.

Keep the active confirmation open while saving or deleting a draft. Disable duplicate submissions and preserve an error message if persistence fails. A close gesture during this operation must not bypass the pending choice. Respect reduced motion and the existing instant dismissal rules once a final choice succeeds.

## Handle browser refresh and tab closure honestly

Provide a visible Save draft action within upload and edit forms so the owner can persist work before leaving. Register `beforeunload` only while there is unsaved work or a pending operation that could be interrupted. Remove it after the current work has been persisted, discarded, or successfully submitted.

Browsers control the refresh/tab-close prompt and do not allow the application's three custom buttons or custom warning text there. Do not promise asynchronous IndexedDB saving during unload. A previously saved draft survives; edits made after that snapshot require another explicit Save draft. Do not add a hidden autosave policy in this phase.

Browser crash, forced process termination, and some mobile tab closures can bypass `beforeunload`. Distinguish a saved draft from unsaved work in the UI. Treat the guard as accidental-dismissal protection, not a guarantee against every browser shutdown.

## Implement in verifiable steps

- [ ] Start from current `development` and create `feat/unsaved-changes-drafts`. Inspect form callers, session cleanup, upload retry semantics, and current tests.
- [ ] Add typed IndexedDB records and transaction-based load/save/delete operations. Verify file bytes and metadata survive an actual browser reload.
- [ ] Add explicit upload-intent reconciliation needed by recovered drafts. Test lost finalize response, expired intent, missing URL, 401, and ambiguous failure before adding UI recovery.
- [ ] Add the shared confirmation and route upload backdrop, Escape, Close, and Cancel through one guarded close owner. Preserve busy-close behavior.
- [ ] Add edit dirty comparison, pending close/cancel destination, draft persistence, and recovery. Preserve framing and existing validation.
- [ ] Add visible draft recovery and explicit replacement/discard actions. Keep failures and conflicts recoverable with the current form intact.
- [ ] Add conditional `beforeunload`, private-device disclosure, saved-time feedback, and storage-limit messages. Verify logout/expiry immediately removes private UI.
- [ ] Run the checks below and record evidence here. Open a PR to `development` following repository instructions. Do not promote to `main` implicitly.

## Verify observable behavior

Use a synthetic local archive and files. Test browser IndexedDB directly rather than treating a mocked adapter as persistence proof.

- [ ] Untouched forms close normally. Each guarded close path with unfinished work shows the three choices, and clicking inside a form never triggers the guard.
- [ ] Continue editing and confirmation Escape keep every field, file, focal position, and focus target. Rapid double-click and repeated Escape cannot bypass the confirmation.
- [ ] Save draft awaits transaction completion. Refresh and browser restart recover identical metadata and file bytes after authentication, without starting uploads or edits automatically.
- [ ] Discard removes the intended draft only. Saved artwork, completed uploads, and unrelated edit drafts remain intact.
- [ ] Missing storage, full quota, invalid records, blocked upgrade, failed deletion, and aborted writes leave the current form open and usable with an error.
- [ ] A pending upload/save/restore cannot be dismissed or duplicated. Partial and unknown uploads resume against their existing intent. A lost finalize response and failed local cleanup do not create duplicate artwork.
- [ ] A newer server edit requires explicit review on recovery. Unavailable artwork is not patched. Two tabs cannot silently replace or delete a newer local draft.
- [ ] Logout/session expiry hides private content immediately without an unsaved-work prompt blocking cleanup. Saved local drafts are shown only after unlock.
- [ ] Native refresh warnings appear only while applicable. No custom three-button browser-close prompt or unload-save guarantee is claimed.
- [ ] At 320 px, 390 px, and desktop widths, check focus containment, screen-reader names, inert background, scroll lock, pending/error states, and reduced motion.

Add unit tests for dirty comparison, draft serialization/validation, and upload-intent recovery. Use existing Vitest and browser tooling. No new IndexedDB mock dependency is required if the real-browser persistence checks cover storage behavior.

Run typecheck, lint on changed files, `tests/integration/accessibility-performance.test.ts`, `tests/integration/gallery-tools.test.ts`, `tests/integration/batch-upload.test.ts`, `tests/integration/uploads.test.ts`, and `tests/integration/thumbnail-framing.test.ts`, plus any new focused tests. Finish with `npm run build` and `git diff --check`. Static source assertions cannot prove safe dismissal or persistence.

## Planning evidence and remaining work

The plan follows the owner's explicit choice of local drafts that survive refresh and browser closure. Source inspection confirmed the upload reset path, direct detail close/cancel paths, persistent tool bodies, and the upload retry condition that needs reconciliation. Application code has not changed. Persistence, confirmation UI, and the acceptance checks above are not implemented yet.
