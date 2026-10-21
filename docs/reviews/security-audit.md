# Independent security design audit

Date: 2026-10-22. Reviewer: GPT-5.6 Sol, xhigh reasoning. Scope: proposed architecture, not source code or deployed behavior. Restored by the coordinator from the reviewer's completed audit and corrections because its file tools retained the earlier sandbox failure.

## Threat model

Assets: private originals/derivatives/notes, login code, sessions, data-provider credentials, push endpoints/key material, VAPID key, backups and provider spend. Actors: owner devices, unauthenticated internet callers, an attacker controlling uploaded bytes or subscription input, and a compromised session.

Entry points: login/CRUD/upload/finalize/asset/subscription/send/export routes, direct object capabilities, notification clicks and preview deployments. Trust boundaries: browser to app; app to pooled DB/private Storage; app to Web Push providers; production to preview; live data to backups.

Main abuse cases: brute-force code login; stolen/replayed sessions; privileged data credentials in a client; CSRF/XSS; malicious image decoding/storage exhaustion; private image caching; push endpoint SSRF; duplicate/unintended sends; incomplete recovery; unauthorized operations after revocation.

## Critical release requirements

| Risk | Required mitigation | Verification |
| --- | --- | --- |
| Guessable/exposed code | CSPRNG code >=128-bit entropy, server-only env, generic POST login, constant-time digest comparison | Missing/weak config fails closed; code absent from bundle/source maps/URLs/logs |
| Serverless abuse-control bypass | Durable atomic IP-hash counters with trusted ingress extraction, global short-window cost ceiling and bounded expiry | Parallel burst yields 429; spoofed forwarded headers do not bypass; restart/redeploy keeps limits; no permanent attacker-triggered account lockout |
| Stolen/stale sessions | Opaque random ID hash, secure HttpOnly SameSite cookie, fresh ID on login, idle/absolute expiry and revocation | Fixation fails; old tokens denied after logout/expiry/revoke/rotation |
| Code rotation fails to revoke | Full domain-separated HMAC over OWNER_ACCESS_CODE with distinct >=256-bit SESSION_VERSION_KEY; store version and recompute/constant-time compare on every protected operation and push target | Rotating either secret revokes prior sessions; missing/weak secret fails closed; in-flight old-deployment behavior documented |
| Supabase service-role bypass | Scoped pooled DB role for app tables; privileged Storage secret isolated in tiny server adapter; anon/authenticated denied; preview isolated | Browser key cannot read/write tables/buckets; scoped DB role cannot reach unrelated schemas; no privileged secret in client/network/logs |
| Unsafe or quota-exhausting upload | Private random quarantine paths, no upsert, ready-only reads, maximum original+derivative reservation, capped outstanding intents, bounded size/pixels/time/memory and actual decoding/re-encoding | Oversize/mislabeled/corrupt/unsafe/decompression inputs fail; EXIF stripped from derivatives; parallel issuance respects ceiling; pending inaccessible |
| Upload bearer lifetime underestimated | Supabase capabilities last two hours; track expiry plus margin, preserve failed-path reservation until expiry/cleanup, reject late finalization | Still-valid capability cannot overwrite or obtain a new unaccounted path; deleted paths cannot recreate unreserved objects; orphans eventually removed |
| Image access survives revocation | Private buckets, <=60-second signed reads, explicit bearer residual window, verify no shared/private offline cache | Public/quarantine paths denied; signed reads expire; actual headers avoid public/s-maxage; logged-out browser cannot reopen offline gallery |
| CSRF/XSS | Exact allowed origin, pre-auth/session-bound CSRF, unsafe methods only for mutations, escaped text, CSP/frame protections and nosniff | Foreign/null origins and cross-site credential forms rejected; stored scripts display literally; framing denied |
| Push SSRF | HTTPS/default port, bounded validated subscription/key inputs, exact supported-provider origins, redirects off, egress blocks private/link-local/nonpublic IPv4/IPv6 and rebinding | Malicious URL/redirect/DNS cases do not reach controlled private canary |
| Duplicate or unintended push | Separate opt-in/send controls, authenticated own targets, durable per-target attempt before provider, cooldown/idempotency, TTL60s and no automatic uncertain retry | Passive actions send nothing; duplicate IDs attempt at most once; accepted != delivered; 404/410 disables subscription |
| Incomplete recovery | Encrypted metadata and object backups, consistency manifest/checksums, isolated restore, no restored sessions/subscriptions/secrets | Empty restore matches counts/bytes and leaves push disabled |

## Required clarifications and residual limits

- The HMAC version is recomputed for login, media issuance, upload/finalize, CRUD, subscription/target selection and sends, and checked against singleton shared AuthState. Domain separation and full output prevent accidental cross-purpose reuse. Rotate the shared active version and revoke old session rows atomically so stale instances cannot accept old code or sessions, including inside mutating transactions. Code/key rotation is an operational change: old deployed instances must be drained/removed or denied before claiming global revocation. Never support old versions indefinitely. Existing upload capabilities may consume already-reserved bytes until their provider expiry, but revoked sessions cannot finalize them.
- Supabase privileged keys bypass RLS project-wide. Application custom sessions are not Supabase Auth JWTs. RLS and a server-only key alone do not establish per-request authorization.
- Signed upload URLs are bearer capabilities, not inherently short-lived or one-time. A used non-overwritable path can become writable again if deleted before capability expiry; retain accounting and cleanup accordingly.
- Preserve original bytes only for private attachment downloads. Sanitize derivatives and reject unsafe inputs; do not serve arbitrary uploaded content inline.
- Signed download URLs cannot promise immediate revocation. Previously downloaded files/screenshots cannot be recalled. If immediate revocation becomes required, evaluate a protected delivery path with platform payload limits rather than claiming bearer URLs can be invalidated.
- No service-worker fetch handler/Cache API is needed. Handle push and notificationclick only, with a fixed same-origin destination and no private payload.
- At-most-once provider attempts can lose a reminder when the process fails after claiming the attempt. Exactly-once delivery is not guaranteed. Already accepted pushes can arrive after logout; generic payload and short TTL limit exposure.
- Label logout **Log out and disable this device**. Revoke server authorization before best-effort subscription cleanup. Failure to clean up must not keep a session valid.
- Tombstone before deleting original/derived objects through Storage APIs; deleting Storage metadata rows directly can leave orphan bytes.
- Database backups exclude Storage object bytes. Coordinate manifest/export against concurrent deletion and restore metadata/files together. Backups retain deleted live data only under the stated retention policy.
- Bound DB connections, unsafe request sizes, provider timeouts and retries. Critical work must not depend on a timer after a serverless response.
- Future local mode needs loopback binding, files outside webroot, narrow cloudflared trusted-proxy handling, host controls, adequate authorization and consistent SQLite backup. It is a separate deployment decision, not implemented support.

## Assessment

The proposed design is acceptable for continued planning when the mitigations above remain explicit release gates. No runtime security result is asserted. Verify the actual implementation and all AC1–AC12 before production use; unresolved critical/high findings block release.

## Official references

- [Supabase RLS and bypass privileges](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Signed upload capability lifetime](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl)
- [Private downloads and signed URLs](https://supabase.com/docs/guides/storage/serving/downloads)
- [Backups exclude Storage objects](https://supabase.com/docs/guides/platform/backups)
- [Vercel Function payload limits](https://vercel.com/docs/functions/limitations)
- [Push API and CSRF considerations](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
