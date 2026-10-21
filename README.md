# Hall of Achievements

A private website for saving finished artwork as achievements and deliberately sending yourself a reminder.

This repository is a product-planning checkpoint. No application has been implemented or deployed.

- [Product requirements](docs/PRD.md)
- [Architecture design](docs/superpowers/specs/2026-10-22-hall-of-achievements-design.md)
- [Product analysis](docs/reviews/product-analysis.md)
- [Storage analysis](docs/reviews/storage-analysis.md)
- [Security audit](docs/reviews/security-audit.md)
- [Antigravity review](docs/reviews/antigravity-review.md) and [finding adjudication](docs/reviews/antigravity-adjudication.md)
- [Work log and verification](docs/WORKLOG.md)
- [Antigravity handoff](docs/ANTIGRAVITY-HANDOFF.md)

Recommended starting point: Next.js on Vercel with Supabase Postgres and private Storage for a small archive. R2 is the storage alternative for larger originals. An entirely local application with SQLite, files, and a named Cloudflare Tunnel is a separate deployment alternative with computer-uptime requirements.

Notifications have separate **Enable notifications** and **Send reminder now** actions. There are no automatic sends in the proposed MVP.

Credentials, private art, local databases, runtime logs, and backups are excluded from Git. Never add the existing credential-bearing `Context7.md` file.
