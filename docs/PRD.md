# Hall of Achievements — Product Requirements

Date: 2026-10-22. Version: 0.1. Status: reviewed planning draft. Product owner: repository owner.

## 1. Purpose and scope

Give one person a fast, private record of their finished artwork. Saving art creates an achievement that is easy to revisit. The owner can deliberately send a push reminder from a website button.

This checkpoint delivers a PRD, architecture recommendation, independent product/storage/security reviews, and a Git checkpoint. Product implementation and deployment are later work; this document does not claim the application exists.

### Confirmed requirements

| ID | Requirement |
| --- | --- |
| U1 | Save artwork as achievements on a website. |
| U2 | Support hosting on Vercel. |
| U3 | Provide push reminders, but notify only through a website button. |
| U4 | Log in using a fixed token/code configured in environment variables. |
| U5 | Keep the application efficient and fast. |
| U6 | Prefer free storage; consider local operation forwarded through Cloudflare. |
| U7 | Follow AGENTS.md/pstack; use varied non-Astra GPT reviewers and inspect artifacts before a GitHub checkpoint. |

### Explicit working assumptions

- One owner, up to five personal devices; all artwork and notes are private.
- An achievement represents one completed artwork and one image in the MVP.
- Supported inputs are JPEG, PNG, and WebP. SVG, GIF, HTML, video, PSD, and arbitrary remote URL imports are excluded.
- Preserve original bytes for downloading; generate separate sanitized display images and thumbnails.
- Permission and actual notification delivery are separate actions. The conservative interpretation is that every send requires a click, not just initial opt-in.
- No schedules or recurring reminders until the owner explicitly chooses them. Enabling notifications does not authorize future automatic sends.
- Cloud providers process stored images; end-to-end encryption is outside the MVP.
- Free tiers are limited starting points. A domain, electricity, bandwidth beyond allowances, or future provider changes may cost money.

### MVP and non-goals

Include code login/logout, paginated gallery/detail views, create/edit/delete achievements, basic title/tag search, private uploads/downloads, storage usage, manual Web Push, and an export/restore procedure.

Exclude public galleries, social features, multi-user accounts, comments, AI generation, payments, OAuth, email/SMS, automatic reminders, and full offline synchronization. Do not introduce a queue or scheduler for the manual-reminder MVP.

## 2. Experience and workflows

### Login

Open the site, enter the owner code into a password field, submit, and receive a server session. Invalid credentials produce a generic error. Throttled requests show a retry time. Missing/weak server configuration fails closed with a useful unavailable state, never a hosted development bypass.

The code must not enter URLs, browser storage, analytics, logs, browser bundles, or source maps.

### Record an achievement

Select **Add achievement**, choose an image, enter title/date/optional notes/tags, then save. Show upload progress and preserve the form on recoverable failure. The achievement appears only when stored bytes have passed validation and metadata has committed.

Proposed product limits: original at most 10 MiB and 20 megapixels; title 1–120 characters; notes at most 2,000 characters; up to ten tags of 24 characters. Completion date is a calendar date, defaults to device-local today, and cannot be in the future. Verify the date server-side against the explicitly supplied user timezone; timezone is a display/validation preference, never an authorization input.

Keep original bytes in private storage for attachment downloads. Derivatives are orientation-corrected, re-encoded, and stripped of metadata. Reject malformed/unsafe inputs rather than relying on filenames or client MIME types.

### Revisit, edit, and delete

Show ready achievements newest first, with stable date/id cursor pagination and 24 items per page. Search titles/tags with a short debounce. Open a larger display image on detail view; load original bytes only on **Download original**.

Edit metadata without re-uploading. Deletion requires clear confirmation, immediately tombstones/hides the achievement, then removes originals and derivatives through recoverable, idempotent cleanup. Report permanent deletion only after object cleanup succeeds. A signed URL issued earlier can retain access until its expiry.

Provide empty, loading, no-results, quota-full, and provider-error states. Core flows must work with keyboard navigation, screen-reader labels, visible focus, and mobile touch controls.

### Notifications

| Control | Required behavior |
| --- | --- |
| Enable notifications on this device | Feature-detect, explain, request permission in the click handler, then save a subscription. Send nothing. |
| Send reminder now | Authenticated, CSRF-protected action; send once to this device by default. Disabled without a valid subscription. |
| Device target selector | Optional explicit selection of the owner's enabled devices, maximum five; never an implicit broadcast. |
| Disable notifications on this device | Remove its server subscription and unsubscribe locally where possible. Send nothing. |
| Log out and disable this device | Revoke current session first, disable its subscription, clear app-managed private state. Cleanup failure must not keep a session valid. |
| Revoke all devices | Explicit owner action invalidates all sessions/subscriptions. |

No permission prompt or push on page load, login, saving art, permission approval, deployment, or timers. No cron, scheduled worker, public webhook, or CRUD event sends reminders.

Use generic lock-screen content without art, titles, notes, credentials, or signed URLs. Clicking opens a fixed same-origin gallery route and requires login when necessary. Server validation cannot prove a physical human click; the product supplies the button-only flow and authenticated send boundary.

Use a 60-second push TTL so immediate reminders do not arrive hours later. Report accepted/rejected/unknown provider outcomes accurately; provider acceptance is not confirmed device delivery. Claim attempts durably before provider calls, use per-target idempotency, and do not automatically retry ambiguous results. This provides at-most-once attempts with possible loss across a crash/provider boundary; the owner can deliberately resend after cooldown.

Denied/unsupported notifications do not break the gallery. Explain settings without repeated prompts. On iPhone/iPad, document the supported Home Screen web-app flow. HTTPS is required in production. See [Apple Web Push requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).

## 3. Architecture and storage decision

### Recommended starting point

Use Next.js App Router and TypeScript on Vercel, Supabase Postgres for metadata/sessions/limits/subscriptions, and private Supabase Storage for images. Server-render ordinary pages; keep client components limited to forms, upload progress, and notification controls. Choose current supported stable versions at implementation time and pin a lockfile then.

Use a least-privilege database role through an appropriate connection pool. Isolate privileged Storage credentials in a small server-only adapter. A custom owner-code session is not a Supabase Auth JWT; do not assume RLS automatically understands it. Every application entry point authorizes the owner session. Deny anonymous/authenticated client roles on application tables, enable RLS as defense in depth, and disable unused Data API access. No privileged browser SDK.

Upload original bytes directly to a private quarantine path after an authenticated intent request. Finalization verifies actual size/signature/ownership, bounded decoding and dimensions, generates derivatives, and marks the achievement ready. Fetch only server-constructed storage paths, never an arbitrary user URL.

This avoids routing originals through a Vercel Function body, which currently has a 4.5 MB request/response limit. [Vercel Functions limits](https://vercel.com/docs/functions/limitations)

### Options

| Option | Benefits | Limitations | Decision |
| --- | --- | --- | --- |
| Vercel + Supabase DB/private Storage | One data provider; simple durable records and private files | Small free file allowance, egress limits, inactive free projects may pause; independent backups needed | Default for a small archive |
| Vercel + R2 + managed SQL | More image capacity and free R2 egress | More provider setup, credentials/CORS and separate DB; overage/account terms still apply | Choose earlier if original-image volume justifies it |
| Entire app local + SQLite/files + named Cloudflare Tunnel | Owner-controlled disk capacity | Requires computer/network uptime, security maintenance, backups and stable hostname | Separate alternative, not a second MVP backend |

Supabase Free currently lists 1 GB file storage and 500 MB database capacity; its free projects can pause for inactivity. R2 Standard currently includes 10 GB-month storage plus operation allowances with free egress. These are 2026-10-22 documentation snapshots, not free-forever guarantees. See the [storage review](reviews/storage-analysis.md) for official sources and details.

Vercel must not use a local SQLite file or local filesystem as durable storage. The local alternative runs the whole app on the owner's machine, binds to loopback, stores files outside the webroot, and forwards through a named HTTPS tunnel. Restrict trusted proxy handling to cloudflared; keep application login/abuse controls and host protection in place. Cloudflare Access may be added if the owner accepts its additional login flow.

A stable hostname preserves cookie/service-worker/subscription identity. Quick Tunnels are temporary development tools, not the permanent deployment. A tunnel provides connectivity and does not replace application authorization. The local alternative changes the Vercel deployment choice and remains future work unless selected.

### Capacity and cost policy

Target zero provider spend within free allowances for small personal use. Before provisioning, check current plan eligibility, quotas, inactivity, billing/card requirements and overage controls. Do not enable paid upgrades without an explicit owner decision.

Configure a byte ceiling at 70% of the actual provider file allowance, counting originals, derivatives, quarantine and outstanding capabilities. Reserve the full allowed original plus bounded maximum derivative bytes atomically at issuance. Limit three outstanding upload intents and reconcile actual object bytes. Reject additional uploads cleanly before the safety threshold; never trust only client-declared sizes.

Supabase signed upload capabilities are bearer tokens valid two hours. Use random paths, no overwrite/upsert, record provider expiry plus a cleanup margin, and do not release reservations prematurely. A completed upload can reclassify reserved bytes to actual bytes only when path immutability is proven; failed/deleted paths remain reserved until capability expiry and cleanup, since a still-valid capability might recreate an object. Expired application intents are never promoted. Bounded maintenance runs during authenticated actions and through an operator command; it never sends push. [Supabase signed uploads](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl)

Show usage and the safety limit. Do not promise an artwork count: compute capacity from measured total bytes per achievement including all derivatives. Implement only the chosen backend first; retain small repository/storage interfaces for later migration.

## 4. Data and boundaries

| Entity | Fields and invariants |
| --- | --- |
| Achievement | UUID, title, completion date, notes, tags, created/updated UTC, pending/ready/deleting state; only ready visible |
| Asset | Achievement ID, random original/display/thumb keys, actual bytes/MIME/dimensions/checksum, validation state; no public URL as authority |
| UploadIntent | ID, session, random path, maximum reserved bytes, capability/application expiry, consumed time, cleanup state; no overwrite |
| Session | Random token hash, authentication version, created/last-seen/absolute expiry/revocation; idle 24 hours, absolute seven days, max five active |
| AuthState | Singleton shared active HMAC authentication version and rotation timestamp; every instance must match it; rotation atomically changes it and revokes old session rows |
| PushSubscription | ID, owning session/device, encrypted endpoint/key material, status and timestamps; max five, excluded from gallery responses |
| ReminderAttempt | Idempotency UUID, session, authorized targets, per-target attempted/accepted/rejected/unknown results; unique request ID |
| RateLimit | Expiring HMAC-hashed trusted client key, scope/window, atomic count; no raw code or request body |

Store timestamps in UTC and completion dates separately as calendar dates. Validate every boundary, use transactions/unique constraints for retries, bound request bodies/timeouts/connections, and never rely on in-memory serverless state for durable locks or counters.

Module boundaries: authentication; achievements; private asset adapter; subscriptions/manual sender; operational export/restore. Keep interfaces small and avoid parallel provider implementations.

Planned same-origin routes:

- `POST /api/session`, `DELETE /api/session`, `POST /api/sessions/revoke-all`.
- `GET/POST /api/achievements`, `PATCH/DELETE /api/achievements/:id`.
- `POST /api/uploads/intents`, `POST /api/uploads/:id/finalize`.
- `GET /api/achievements/:id/assets` for authorized, ready, short-lived signed reads.
- `POST/DELETE /api/push/subscriptions`, `POST /api/reminders/send`.

Expose stable errors for unauthenticated, throttled, invalid file, quota full, expired upload and provider unavailable. Hide credentials, internal paths and provider stack traces.

## 5. Security and privacy requirements

- `OWNER_ACCESS_CODE` must be a CSPRNG-generated secret with at least 128 bits entropy, server-only. No short numeric PIN. Do not silently normalize input. Compare fixed-length digests in constant time.
- Separate a strong `SESSION_VERSION_KEY`, rate-limit salt, subscription encryption key, database/storage credentials and VAPID private key. Public VAPID key is intentionally public. No secrets in `NEXT_PUBLIC_*`.
- Compute a domain-separated full-length HMAC authentication version from a distinct >=256-bit session-version key and current code. Store it on sessions and check against current configuration plus shared AuthState for every protected operation, login and selected push target. Changing either secret invalidates earlier sessions on updated instances. Missing/weak secrets fail closed. Treat rotation as maintenance: atomically activate the new auth version in the shared database and revoke old session rows; require every instance to match that active version, including within mutating transactions. Older deployments then fail closed even if their environment is stale. Remove/drain outdated deployments and protect historical preview URLs before declaring rotation complete; do not retain dual-version acceptance. Test old in-flight requests. Previously issued signed reads/pushes have their stated residual windows; an old upload capability can still consume its reserved bytes for the provider's two-hour lifetime but cannot finalize using a revoked session.
- Issue random opaque session tokens, store only their hashes, replace any presented session token on login, and use HTTPS `__Host-` cookies: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain. Use a separate explicit localhost cookie configuration. Enforce idle/absolute expiry and server revocation.
- Proposed login limit: five failed attempts per 15 minutes per trusted client IP hash, plus an owner-wide short-window cost ceiling. Counters are atomic/durable, keys expire, arbitrary forwarded headers are untrusted, and DB failure denies login. Global ceilings may temporarily deny the owner; no persistent attacker-triggered account lockout.
- Protect unsafe methods with exact allowed Origin plus session-bound CSRF tokens; bootstrap login CSRF through its pre-auth form flow. Reject null/foreign origins, permissive credential CORS and GET side effects. Validate canonical origin from configuration, not untrusted Host headers.
- Render titles/notes as escaped text. Use CSP with frame-ancestors/object-src/base-uri restrictions, nosniff and a restrictive referrer policy. Verify actual deployment headers and framework compatibility.
- Keep all bucket objects private. Original downloads use attachment disposition. Signed read lifetime is at most 60 seconds, with an explicit residual access window after logout/code rotation. If immediate revocation is later required, evaluate authenticated streaming against platform payload limits instead of claiming signed URLs can be recalled.
- Private pages, API responses, signed URL issuers and thumbnails must not enter shared caches. Verify actual Storage response headers. Use no service-worker fetch handler or Cache API in this MVP; it handles push/notificationclick only. No private offline gallery.
- Treat push endpoints as attacker input: HTTPS/default port, bounded length/valid keys, no userinfo, exact supported-provider origin allowlist, no redirects, and egress protection against nonpublic IPv4/IPv6, metadata endpoints and DNS rebinding. Unsupported providers disable push safely.
- Default send targets to current device, maximum five active own subscriptions. Enforce a durable one-minute owner cooldown and per-target idempotency. Record attempt before calling provider, never retry ambiguous results automatically, and remove 404/410 subscriptions.
- Logout/expiry/revoke-all/code rotation exclude old subscriptions. Already accepted in-flight pushes cannot be recalled; generic content and short TTL limit exposure. Check target authorization immediately before each send.
- Logs contain only event/request IDs, outcome and duration; no cookies, codes, signed URLs, push endpoints, art content or secrets. Keep operational events at most seven days absent a specific investigation.
- Separate local/preview/production origins, data, credentials and VAPID keys. Preview must not write production data or notify production devices.

The [security audit](reviews/security-audit.md) provides threat-based checks. This is a design audit, not a runtime assurance claim.

## 6. Speed, accessibility, and reliability

Targets are proposed budgets, not measurements:

| Metric | Target and measurement |
| --- | --- |
| Initial gallery transfer | <=1 MiB for app assets plus first 24 thumbnails, clean cache; originals excluded and never fetched implicitly |
| Mobile lab experience | LCP <=2.5 s, CLS <=0.1 on a documented fixed device/network; cold and warm runs separate |
| Interaction | p75 INP <=200 ms once enough field traffic exists; report pre-release scripted interaction timings as lab data |
| Metadata API | Warm p95 <=500 ms over 100 authenticated requests near selected region; measure cold start separately |
| Persistence | Saved metadata and bytes survive refresh, new login and Vercel redeploy |
| Accessibility | WCAG 2.2 AA intent; manually verify keyboard, labels, focus, errors, contrast and touch flows alongside automated checks |

Use paginated queries, relevant indexes, small selects, responsive derivatives, reserved image dimensions, and below-fold lazy loading. No continuous polling, needless realtime service, large animation library or global state store. Select nearby app/data regions after verifying actual location; timezone alone is not proof.

Release measurement procedure: record deployed commit/region, Chrome and Lighthouse versions, mobile viewport/device emulation, CPU/network throttling and cache settings. Run five cold and five warm gallery navigations; report cohort medians against the lab LCP/CLS budgets and show worst runs separately. Capture browser network transferred bytes for the full first 24-item gallery on empty cache. Use a bounded authenticated request harness for 100 warm metadata reads, report p95 and errors, and record cold starts separately. Browser interaction timings remain lab results; only real-user instrumentation with sufficient traffic supports field p75 INP claims. Save the run settings/results with the implementation release evidence; no such measurements exist yet.

An acknowledged save must not precede durable object and metadata completion. DB outage denies authentication/mutations with retryable UI; upload interruptions retain recoverable pending state. Push failures do not block the gallery. Do not rely on background work continuing after a serverless response.

## 7. Recovery and operations

Proposed recovery objectives: daily backups giving a <=24-hour recovery point and <=2-hour restore in a documented drill. These are owner-operated targets, not an SLA; mark them unmet until scheduling and a restore drill actually exist.

Provide an operator export command for schema-versioned metadata, original/derived assets, a consistency manifest and checksums. Avoid routing a large archive through Vercel. Encrypt off-site backups, keep seven daily copies, and exclude sessions, codes, provider credentials and push subscriptions. Coordinate snapshot/export and deletion so files referenced by the manifest remain available until export completes.

Database backups do not contain Supabase Storage objects. Back up both separately and restore together. [Supabase backups](https://supabase.com/docs/guides/platform/backups)

Restore into an isolated environment, validate counts/checksums and login, and leave sessions revoked/push disabled. For future SQLite mode use online backup or stop writes; copying an active DB alone is insufficient.

Show quota/error summaries and perform initial weekly operator checks. During suspected compromise revoke sessions/credentials and disable push before investigation. Deletion removes live copies through Storage APIs; retained encrypted backups expire under the documented seven-copy policy. Existing downloads/screenshots cannot be recalled.

## 8. Acceptance and release gates

| ID | Observable release check |
| --- | --- |
| AC1 | Wrong/missing code cannot access pages, metadata, assets, upload capabilities or push. Correct code works; no secret in bundle/URL/logs. |
| AC2 | Concurrent abuse limits persist across cold starts/redeploy; spoofed forwarded headers cannot bypass; missing DB fails closed. |
| AC3 | Valid art survives refresh, another device login and redeploy; finalize retries create one ready achievement. |
| AC4 | Reject excessive size/pixels, mismatched/corrupt/unsafe files; quarantine is unreadable; parallel reservations respect full byte ceiling; expired intents cannot promote and orphans clean up. |
| AC5 | Pagination/search/edit/delete work; interrupted deletion recovers; originals/derivatives are private and signed reads expire within 60 seconds. |
| AC6 | Passive actions never prompt or send. Enable prompts only on click and sends zero pushes; Send reminder now causes an actual authorized Web Push attempt. |
| AC7 | Denied/unsupported fallback works. Test actual desktop and supported mobile devices; include iOS Home Screen when claiming support. A local toast does not pass. |
| AC8 | Duplicate send returns stored outcome without a second attempt; cooldown durable; 404/410 disables subscription; malicious/private/redirecting/rebinding endpoints fail egress tests; acceptance never labeled delivery. |
| AC9 | Logout, idle/absolute expiry, revoke-all, code change and version-key change deny earlier sessions and exclude subscriptions; shared active-version rotation denies old deployments too, including old-code login and mutations; remove/drain stale deployments/protect historic URLs and test in-flight requests before declaring rotation complete; notification click cannot bypass login; residual bearer/in-flight limits documented. |
| AC10 | Keyboard/mobile flows, proposed performance budgets, CSP/CSRF/XSS controls, and private cache isolation tested on built/deployed app with measurement context. |
| AC11 | Export/restore to empty isolated environment preserves counts/checksums; sessions/push stay disabled; daily-backup objective met or clearly recorded unmet. |
| AC12 | Inspect final source/diff; run applicable lint/type/build/behavior checks; scan tracked files for secrets; resolve critical/high security findings; commit reviewed files and verify remote SHA before reporting push success. |

None of the application acceptance tests has run in this planning checkpoint because no application exists. Documentation verification and tool outcomes belong in WORKLOG.md.

## 9. Delivery milestones

| Milestone | Deliverable | Exit gate |
| --- | --- | --- |
| M0 — Plan/Design | PRD, architecture, independent reviews, Git checkpoint | Consistency/security design review complete; assumptions and verification limits explicit |
| M1 — Foundation/login | Supported framework, lockfile, env validation, migrations, sessions and limits | AC1, AC2, AC9 |
| M2 — Art archive | Private two-phase upload, validation/derivatives, gallery/CRUD/search/usage | AC3–AC5 |
| M3 — Manual push | Minimal manifest/service worker, explicit controls, protected sender | AC6–AC9 on real devices |
| M4 — Hardening/recovery | Accessibility/performance/security, export/restore and runbooks | AC10–AC12 |
| M5 — Deploy/Maintain | Chosen hosting/data configuration, deployed verification and rollback notes | Actual login/upload/privacy/push checks, backup/quota setup and monitored errors |

Dependencies: chosen provider accounts, secrets generated outside Git, GitHub access/destination, Vercel access, supported push devices and stable HTTPS origin. Local mode additionally needs always-on hosting, named tunnel/domain configuration and dependable backups.

Do not promise a delivery date before testing actual upload processing and device Web Push. These are the principal feasibility checks.

## 10. Decisions for later owner review

1. May a button schedule a later reminder, or must sends be immediate? Default: immediate only.
2. Is all artwork private to one owner? Default: yes.
3. Prefer Vercel with limited cloud storage or local capacity with uptime obligations? Default: Vercel + Supabase for a small archive.
4. Preserve originals despite capacity cost? Default: yes.

The owner authorized autonomous PRD preparation and checkpointing. Defaults are explicit assumptions, not a claim that every implementation choice has been approved. Follow applicable design/planning review steps before product implementation.
