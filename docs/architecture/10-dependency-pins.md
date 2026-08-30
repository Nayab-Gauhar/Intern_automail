# Pinned dependency versions

Resolved from the npm registry on 2026-08-31. **Exact pins, no ranges** — a caret on a
framework is how a green CI turns red overnight without a commit.

## Core

| Package | Pin | Note |
|---|---|---|
| `next` | `16.3.3` | latest stable; `16.0.0-beta.0` and canary rejected |
| `react` / `react-dom` | `19.2.8` | required by Next 16 |
| `typescript` | `7.0.2` | latest stable |
| `prisma` (CLI) | `7.10.0` | **see warning** |
| `@prisma/client` | `7.10.0` | must match CLI exactly |
| `tailwindcss` | `4.3.3` | v4 is CSS-first — config lives in `globals.css` via `@theme`, **not** `tailwind.config.js` |
| `zod` | `4.5.4` | v4 API (`z.email()`, not `z.string().email()`) |
| `lucide-react` | `1.37.0` | |
| `react-hook-form` | `7.87.0` | |
| `googleapis` | `176.0.0` | |
| `@playwright/test` | `1.62.1` | |

## ⚠️ Prisma: do not use `latest`

`prisma@latest` currently resolves to **`8.0.0-rc.12`**, a release candidate, while
`@prisma/client@latest` resolves to stable `7.10.0`. Installing both with `latest` yields a
**mismatched CLI and client** — a generator/runtime version skew that fails at generate or,
worse, at runtime.

We pin both to **`7.10.0`** (`dist-tags.prev`, the current stable line). Revisit when
Prisma 8 leaves RC.

## Rules

- Exact versions in `package.json` — no `^`, no `~`.
- `bun.lock` is committed.
- Upgrades are deliberate commits that pass typecheck, lint, and the full test suite.
- Tailwind is **v4**: any doc or code assuming a `tailwind.config.js` with `theme.extend`
  is wrong for this project.
