# Dependency security policy

How Mailroid keeps its dependencies patched, what blocks a merge, and how an
advisory that cannot be fixed yet gets accepted on the record rather than ignored.

## What runs

| Mechanism | Where | What it does |
|---|---|---|
| Security audit workflow | `.github/workflows/security-audit.yml` | `pnpm audit --prod` on every PR, every push to `main`, and weekly. **Fails on high or critical.** |
| Dependabot version updates | `.github/dependabot.yml` | One grouped minor+patch PR per week; majors arrive as separate PRs. Majors of next, react, better-auth and inngest are ignored and done by hand. |
| Dependabot security updates | Repository setting | A PR as soon as an advisory lands. Enable under Settings → Code security. |

## The gate

- **Critical or high** in the production graph: the audit job fails.
- **Moderate or low**: listed in the job summary; never blocks a merge.

The production baseline was **0 critical / 0 high** when the gate was added
(2026-11-14). A red audit therefore always means something new happened: a
dependency was added or changed, or an advisory was published against a version
you already ship.

## When the gate fails

1. **Read the advisory, then decide whether it reaches production.** Check the
   affected function or configuration against how Mailroid actually uses the
   package. Most advisories need a feature or flag this app does not enable;
   several of the 2026-11 Next.js and better-auth criticals were like that.
2. **Fix it if a patched version exists.** That holds even when the advisory does
   not apply: an unpatched dependency is one config change away from mattering.
   - Direct dependency: bump it in that package's `package.json`.
   - Transitive dependency: bump the parent if a release pulls in the fix.
     Otherwise add a **range-scoped** override in the root `package.json`
     under `pnpm.overrides`, pinned with a caret to the patched release *in the
     same major*. For example, `"minimatch@>=3.0.0 <3.1.4": "^3.1.4"`, never
     `">=3.1.4"`, which can jump a consumer onto a new major.
   - An auto-installed peer (inngest → h3 was one) can stay locked at the old
     version even with an override in place. Running `pnpm update -r <parent>`
     re-resolves it.
3. **Accept it only if no fix exists.** Record it before ignoring it:
   - Add its CVE to `pnpm.auditConfig.ignoreCves` in the root `package.json`.
   - Add a row to the table below: advisory, why it does not reach production
     or what mitigates it, who accepted it, and the date to look again (at most
     90 days away).
   - Remove both entries as soon as a fix ships.

Overrides are scaffolding, not permanent fixtures. Once a parent package ships
the fix, delete its override and confirm `pnpm audit --prod` stays clean.

## Accepted risks

| Advisory | Package (via) | Why accepted / mitigation | Accepted by | Revisit by |
|---|---|---|---|---|
| none | | | | |

## Known moderate/low findings (not gated)

The state on 2026-11-14 after remediation, so the next review starts from a
known list:

- `@opentelemetry/instrumentation-*` (pg, mysql, http, and others), via
  `inngest` → `@opentelemetry/auto-instrumentations-node`: database usernames
  or sensitive values can reach span attributes. The fix needs an inngest-side
  bump. Mailroid's own telemetry passes through the Alloy redaction layer.
- `esbuild` 0.18 (dev-server CORS), via `drizzle-kit` → `@esbuild-kit/*`. Used
  only when running drizzle-kit; it never runs in a served process.
- `glob` 10 / `minimatch` 9 (DoS), via `gaxios` → `rimraf`. Only reached when
  deleting temp files on paths the app chooses itself.
- `postcss-selector-parser` 6 (CPU), via `@tailwindcss/typography`. Runs at
  build time only.
- `baseline-browser-mapping` (DoS on invalid input), via `next`. Build time only.
- `deepmerge` (low), via `jest-config`, which corsair's dependency tree pulls
  into the production graph. It is test tooling and never loaded by a served
  process.
