# Storage and hosting analysis

Snapshot: 2026-10-22. Reviewer: GPT-6 Sol, medium reasoning. Restored by the coordinator from completed research messages because the reviewer's sandbox remained unable to write. Quotas/pricing below are documentation snapshots, not guarantees.

## Recommendation

Use Vercel Hobby plus Supabase Free for the first small private archive when total originals, display images, thumbnails and pending uploads fit comfortably below the file allowance and the owner accepts inactivity pauses. Reserve a conservative 70% safety ceiling. If expected original-image volume already exceeds this capacity, select R2 from the start and retain a managed SQL database.

Do not claim a small free Supabase project is always available: inactivity can cause pausing. Do not create artificial activity jobs to disguise that tradeoff. Back up independently.

## Comparison

| Option | Documented starting allowance / properties | Main tradeoff |
| --- | --- | --- |
| Supabase Free | 500 MB DB; 1 GB files; 5 GB egress plus 5 GB cached egress; up to two active projects | Low-activity projects can pause after a seven-day period; image capacity is limited; free backup/export is owner-operated |
| R2 Standard | 10 GB-month/month free; 1 million Class A and 10 million Class B operations/month; free egress | Separate database still needed; extra setup and potential overages/billing requirements |
| Local SQLite/files + named tunnel | Owner's available disk; outbound tunnel avoids opening a public inbound application port | Computer, internet and tunnel must remain running; owner maintains security, updates, off-site backups and stable hostname |

R2 Standard overage snapshot: $0.015/GB-month, $4.50/million Class A operations and $0.36/million Class B operations. Its free tier does not apply to Infrequent Access. Verify account/card requirements, eligibility and cost controls before provisioning.

Vercel Hobby is intended for personal small-scale projects. Check current eligibility before commercial use. A local SQLite file inside a Vercel Function is not a durable database strategy.

## Storage design implications

- Direct browser-to-private-storage uploads avoid Vercel's 4.5 MB Function body limit.
- Use authenticated upload intents, private quarantine and server finalization. Bucket MIME/size limits complement, not replace, stored-byte validation.
- Supabase signed upload URLs are bearer capabilities with provider-defined lifetime; account for it in reservation/cleanup. They are not inherently one-use.
- Never send Supabase privileged keys, database credentials, R2 secrets or VAPID private keys to the browser.
- Use short signed reads only for authorized ready assets. Treat bearer expiry and response cache behavior explicitly.
- Custom code sessions are not Supabase Auth identities; scope application DB credentials and authorize requests explicitly.
- Back up metadata and object bytes. Supabase database backups alone cannot restore deleted image objects.
- Estimate capacity using actual bytes per achievement including every derivative and staged upload, not the original alone.

## Local deployment alternative

Run the entire app locally with SQLite and files, bind to loopback, keep images outside the webroot, use a stable named tunnel and application authentication, and configure trusted proxy handling narrowly. A production custom hostname requires appropriate Cloudflare domain/zone routing. Domain registration and electricity may cost money.

Quick Tunnels have temporary hostnames and no production availability promise. Changing origins disrupts cookies, service workers and push subscriptions. A tunnel does not keep a sleeping computer available or replace backups/authentication. This alternative changes the default Vercel hosting decision and is not implemented in this checkpoint.

## Reminder infrastructure

Use standards-based Web Push with HTTPS, service worker and VAPID. Separate **Enable notifications** (permission/subscription following a user gesture) from **Send reminder now** (authenticated manual server action). No cron is required. iOS/iPadOS needs a supported Home Screen web-app flow. Do not promise device delivery from provider acceptance.

## Official references

- [Supabase pricing](https://supabase.com/pricing)
- [Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Database backups and Storage exclusions](https://supabase.com/docs/guides/platform/backups)
- [Private/public buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Vercel Hobby](https://vercel.com/docs/plans/hobby)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Named Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
