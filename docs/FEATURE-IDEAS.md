# Saved feature ideas

The [implementation plan](superpowers/plans/2026-10-27-art-archive-enhancements.md) covers every selected idea below. The process gallery remains optional.

## 4. Fullscreen artwork viewing

Status: implemented 2026-10-27 (Phase 1); focused tests and browser checks passed.

Open artwork in a fullscreen viewer to inspect details and browse the archive without returning to the grid.

The selected idea includes:

- Zoom and pan to inspect the artwork.
- Next and previous controls to move between artworks in the current gallery order and filters.
- Keyboard navigation, visible controls, and a clear way to close the viewer.
- Private artwork access through the existing authenticated asset flow.

This records the fourth idea from the feature discussion. The implementation plan covers browser fallback and pagination behavior.

## 6. Tag browser

Status: implemented 2026-10-27 (Phase 2); focused tests and browser checks passed.

Browse clickable tags to find related artwork without remembering search terms. Build on the existing tags and gallery search.

The implemented browser uses exact tag membership rather than substring search, offers an All tags control, and reflects search and date filters in the available tags.

## 7. Contact sheet export

Status: implemented 2026-10-27 (Phase 4); focused tests and browser checks passed.

Select artworks and download a grid of them as one image. Use the result as a visual record of a period or a group of finished pieces.

Selection is capped at 24 loaded artworks. The export requests authenticated display derivatives in selection order and downloads a white PNG with plain captions; it never routes originals through the browser.

## 8. Process gallery

Status: saved as optional by the owner, covered by a deferred phase in the implementation plan.

Attach sketches and intermediate versions to a finished piece so its creative process can be revisited. Assess additional storage usage and changes to the current one-image-per-achievement model before planning implementation.

## 9. Batch uploads

Status: implemented 2026-10-27 (Phase 6); focused tests and browser checks passed.

Add several artworks together, then enter each artwork's details. Preserve the existing validation, storage quota, and upload limits. Show each file's result so failed uploads can be retried without duplicating successful ones.

The implemented queue uploads one file at a time, keeps per-artwork details, and reuses the same upload intent on retry, so a lost response never creates a second record. Quota or slot exhaustion pauses the queue instead of dropping items.

## 10. Archive health check

Status: implemented 2026-10-27 (Phase 5); focused tests and browser checks passed.

Identify artwork with missing stored images and offer the existing restore action. Distinguish a missing file from a temporary request failure before recommending restoration.

The implemented panel starts only from Check archive, pages through the active search, date, and tag scope, and probes object metadata in batches of eight. Missing files, unverified files, and records with no linked asset stay distinct. Restore opens the existing detail dialog; the check never repairs, replaces, or deletes anything.

These entries record selected ideas. Entries not marked implemented remain planned.

## 12. Recoverable trash

Status: implemented 2026-10-27 (Phase 7); focused tests and browser checks passed.

Move deleted artwork to a recoverable trash view before permanent removal. Keep its images and metadata until the owner explicitly chooses permanent deletion.

Deleting an artwork now moves it to Trash, where it stays hidden from the gallery, search, tags, health checks, and upload replay while still counting toward storage. Restoration is one action; permanent deletion reports pending cleanup instead of claiming success when the provider refuses to remove the files.

## 13. Viewer backgrounds

Status: implemented 2026-10-27 (Phase 1); page-session backgrounds verified in the browser.

Switch the artwork viewer between light, gray, and black backgrounds to inspect contrast and transparent areas.

## 14. Collections

Status: selected by the owner, included in the implementation plan.

Arrange related artworks into an ordered series or project. Removing a collection or a member does not delete the artwork.

## 16. Thumbnail framing

Status: implemented 2026-10-27 (Phase 3); focused tests and browser checks passed.

Choose how an artwork is framed in its gallery card without changing the original image.
