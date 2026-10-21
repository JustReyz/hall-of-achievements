# Antigravity review — coordinator adjudication

Date: 2026-10-22. Returned reviewer: GPT-OSS 120B, medium effort, through a separate Antigravity CLI invocation. The retry returned SUCCESS; no claim of attachment to interactive PID 27252 or runtime assurance is made.

The [returned report](antigravity-review.md) is retained for transparency. Suggestions were evaluated against the actual PRD and provider contracts, following review-reception guidance. Its conclusion permits continued planning and found no critical/high contradictions; the suggested medium/low changes require the dispositions below rather than blind adoption.

| Finding | Disposition | Evidence and final decision |
| --- | --- | --- |
| Rotation/drain procedure missing | Addressed | PRD AuthState/security/AC9 and architecture now require shared active-version checks at login/protected operations, atomic activation/revocation, stale-instance/mutation denial, drain/removal and historical URL protection. This was also independently caught by the saved-file reviewer. These edits overlapped the Antigravity run. |
| Make upload URLs single-use using consumed flag; expired app intent must force provider 403 | Rejected as a provider guarantee | Finalization idempotency and consumed state do not revoke a provider bearer capability. Supabase documents a two-hour validity, independent of an earlier app expiry. PRD explicitly reserves maximum bytes across expiry/deletion/recreation and forbids expired-intent promotion. Expect provider rejection after actual capability expiry, not immediately after local intent expiry. |
| Missing concrete SSRF protection; use wildcard provider domains | Existing requirement retained; wildcard suggestion rejected | PRD/security audit already require exact supported-provider origins, nonpublic IPv4/IPv6 and DNS-rebinding protection, and no redirects. Broad *.googleapis.com or *.apple.com allowlists would weaken that requirement. Actual provider origin inventory and egress enforcement must be proven during implementation; Vercel/Cloudflare firewall availability is not assumed. |
| Download revocation fallback/window missing | Already specified | <=60-second signed reads and unavoidable residual bearer access are explicit. Immediate revocation is not a current requirement. Verify actual Storage response cache headers; a browser request header cannot guarantee a server response's no-store policy. Do not claim a client header revokes a bearer URL. |
| Add cron for orphan cleanup | Not needed for chosen MVP | PRD defines bounded authenticated maintenance and an operator cleanup command, preserving reservations until safe cleanup. No automatic upload cleanup SLA is promised while the app is unused. Adding a scheduler now adds operational scope without a demonstrated requirement; never connect cleanup to reminder sending. |
| Add named performance measurement procedure | Accepted clarification | PRD now specifies Chrome/Lighthouse settings, five cold/five warm runs, cohort summaries, full initial transfer capture, 100-request warm API p95/error reporting and separation from field INP. This remains a release plan, not an executed benchmark. |

## Remaining implementation gates

All runtime claims still require AC1–AC12. In particular prove provider upload expiry/non-overwrite behavior, accurate reservation reconciliation, cache headers, supported push provider egress validation, rotation against old deployments, real-device sends and complete backup restoration. No application code exists to test in this checkpoint.

Official contract used for upload adjudication: [Supabase createSignedUploadUrl](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl).
