# Antigravity returned review

Date: 2026-10-22. Separate CLI reviewer: gpt-oss-120b-medium, medium effort. CLI status: SUCCESS. This is the returned model report, not an endorsement of every suggestion. Read [coordinator adjudication](antigravity-adjudication.md) for accepted/rejected findings and the final design decisions. The report was produced while rotation clarifications were being finalized. No exact-PID attachment or runtime verification is claimed.

---

**Model:** GPT‑OSS 120B (Medium)
**Scope:** Architecture & security design review of the Hall of Achievements documentation (AGENTS.md, PRD.md, design spec, product‑analysis, storage‑analysis, security‑audit).

---

### Material Findings

| Severity | Document & Section | Issue & Why it Matters | Suggested Correction | Observable Acceptance Check |
|----------|--------------------|------------------------|----------------------|------------------------------|
| **Medium** | **PRD.md – § 5 Security & privacy requirements** (lines 147‑150) | The rotation of the `SESSION_VERSION_KEY` is described, but there is no concrete process to guarantee that *all* running instances are drained before a new secret takes effect. Without this, stale instances could still accept requests, violating the “rotate‑and‑revoke” guarantee. | Add an explicit deployment‑drain procedure (e.g., stop new traffic, wait for in‑flight requests to finish, then redeploy with the new key) and document it as a mandatory release gate. | Verify that after a rotation the logs from any instance started before the rotation reject session‑version checks (recorded as “invalid session version”). |
| **Medium** | **Security‑audit.md – § 30‑33** (lines 30‑34) | The audit notes that “signed upload URLs are bearer capabilities, not inherently short‑lived or one‑time.” The PRD, however, states “Signed upload capabilities are bearer tokens valid two hours” and implies they are safe to reuse only once. This inconsistency could lead to accidental reuse or orphaned objects. | Clarify that signed URLs are **single‑use** by enforcing a server‑side “consumed‑flag” on finalization, and explicitly document the cleanup of expired/unused capabilities. | After an upload intent expires, a test request to the same signed URL must return **403 Forbidden**, and the reserved bytes must remain counted until the cleanup job runs. |
| **Medium** | **Security‑audit.md – § 24‑26** (lines 24‑27) | The design mentions “treat push endpoints as attacker input” but does not list concrete egress restrictions for private IPv4/IPv6 ranges or DNS‑rebinding protection. This leaves a potential SSRF vector via malicious subscription payloads. | Add a whitelist of allowed push provider hostnames (e.g., `*.googleapis.com`, `*.apple.com`) and enforce outbound network filtering in the Vercel serverless runtime (or via Cloudflare firewall) to block private/internal IPs. | Attempt a push subscription with a crafted endpoint pointing to a private address; the API must reject it with a validation error logged. |
| **Medium** | **Security‑audit.md – § 24‑28** (lines 24‑28) | “Image access survives revocation” is acknowledged, but the design does not provide a fallback for revoking already‑issued signed download URLs (they remain valid for up to 60 s). The PRD claims “if immediate revocation is later required, evaluate protected delivery” but no decision is made. | Document the exact residual window (e.g., 60 s) and add a client‑side cache‑bypass header (`Cache-Control: no-store`) on download responses. Include a note that any revocation scenario must accept the short window. | After logout, attempt to use a previously‑issued signed URL; it should fail after the 60‑s window (verify with a timed test). |
| **Low** | **Storage‑analysis.md – § 23** (lines 23‑27) | The quota reservation model relies on “reserved bytes” persisting until capability expiry, but there is no scheduled cleanup job defined to reclaim reservations on failed uploads. | Define a lightweight background cleanup (e.g., a Vercel cron‑triggered function) that scans for expired upload intents and releases their byte reservations. | Run a test where an upload intent is created then abandoned; after the cleanup interval the reported quota should increase accordingly. |
| **Low** | **PRD.md – § 6 Speed, accessibility, and reliability** (lines 166‑174) | Performance targets are listed as “budgets”, but there is no explicit measurement plan (e.g., instrumentation, tooling) to verify they are met on the chosen free‑tier resources. | Add a measurement plan (Lighthouse CI, synthetic labs) referenced in the release gate checklist. | CI run reports that LCP ≤ 2.5 s and API latency ≤ 500 ms for a warmed Vercel deployment. |

---

### Design‑review vs. Runtime‑assurance

*All findings above are **design‑review** items.* They relate to the documented architecture, threat model, and operational procedures. No claims are made about actual code execution or deployed runtime behavior, and therefore no runtime‑assurance verification is performed here.

---

### Release‑Readiness Assessment (Planning Phase)

- The documentation **overall** aligns with the core goals: a private single‑owner art archive hosted on Vercel, fixed server‑environment login via `OWNER_ACCESS_CODE`, efficient use of free‑tier storage, and Web‑Push limited to an explicit “Send reminder now” button.

- **Outstanding design gaps** (listed above) must be resolved before the design can be considered *release‑ready* for implementation. Each correction has an observable acceptance check that can be validated in an early prototype or CI pipeline.

- Given that the current checkpoint is **documentation‑only**, the design is **acceptable for continued planning** provided the listed medium‑severity issues are addressed and incorporated into the release‑gate checklist. No critical or high‑severity contradictions were found.

**Conclusion:** Proceed to implementation planning after the suggested corrections are incorporated and the acceptance checks are verified.
