# Lead integration notes

Running list of fixes the lead applies when merging agent work. Each entry is a real defect
found by running tooling, not a style preference.

## 1. Prisma 7 removed `directUrl` from the schema (BREAKING)

`prisma validate` fails with:

> The datasource property `directUrl` is no longer supported in schema files.
> Move connection URLs to `prisma.config.ts`.

In Prisma 7 the `datasource` block accepts `provider` and `url` only. A pooled/direct URL
split now lives in `prisma.config.ts` at the repo root.

**Fix:** drop `directUrl` from `prisma/schema.prisma`; carry `DIRECT_DATABASE_URL` in
`prisma.config.ts` instead. Any architecture doc showing `directUrl` in the schema is
describing Prisma ≤6 and must be corrected.

## 2. `@types/react-dom` does not track React's version

`@types/react-dom@19.2.8` does not exist even though `react-dom@19.2.8` does. The type
packages version independently: `@types/react@19.2.18`, `@types/react-dom@19.2.5`.

**Fix:** applied in `package.json`. Never assume a `@types/*` version mirrors its runtime
package.

## 3. Prisma CLI `latest` is a release candidate

See `10-dependency-pins.md`. Both `prisma` and `@prisma/client` are pinned to `7.10.0`.

## 4. `next lint` was removed in Next 16

Next 16's CLI no longer has a `lint` command (`next --help` lists build, dev, start, info,
typegen, upgrade… and no `lint`). A `"lint": "next lint"` script silently fails.

**Fix:** `"lint": "eslint ."` with a flat config in `eslint.config.mjs`.

## 5. TypeScript 7 breaks the whole lint toolchain

`typescript-eslint@8.68.0` hard-refuses TS 7:

> typescript-eslint does not support TS 7.0.

TS 7 is the native (Go) port; the lint ecosystem targets the TS 6 API. Its peer range is
`typescript: >=4.8.4 <6.1.0`. Since `eslint-config-next` depends on `typescript-eslint`,
TS 7 makes linting impossible, not merely degraded.

**Fix:** pinned **TypeScript 6.0.3** — the newest stable version the lint ecosystem
supports. Revisit when typescript-eslint ships TS 7 support
(typescript-eslint issue #10940).

## 6. ESLint 10 breaks typescript-eslint at runtime

With ESLint 10.9.1, every lint run throws:

> TypeError: scopeManager.addGlobals is not a function

The plugins declare `eslint: ^8.57.0 || ^9.0.0 || ^10.0.0` as a peer, but at least one
still calls ESLint 9's scope-manager API. **A declared peer range is not evidence that a
combination works** — only running it is.

**Fix:** pinned **ESLint 9.39.5**. Verified `eslint .` exits 0.

## 7. `eslint-config-next` already registers `jsx-a11y`

Adding `eslint-plugin-jsx-a11y`'s recommended config alongside `eslint-config-next` fails
config loading outright:

> ConfigError: Key "plugins": Cannot redefine plugin "jsx-a11y".

`eslint-config-next` bundles `@next/next`, `react`, `react-hooks`, `import`, **and**
`jsx-a11y`. Do not re-register any of them.

**Fix:** rely on `...next` for jsx-a11y; layer only rule overrides on top.

## Verified toolchain (all commands exit 0)

| Tool | Pin | Status |
|---|---|---|
| Bun | 1.4.0 | installs 276 packages clean |
| Next | 16.3.3 | CLI operational |
| TypeScript | **6.0.3** | downgraded from 7.0.2 for lint support |
| ESLint | **9.39.5** | downgraded from 10.9.1; `eslint .` exits 0 |
| Prisma | 7.10.0 | CLI + client matched |

`bunx tsc --noEmit` currently exits 2 with `TS18003: No inputs were found` — expected
while no `.ts` files exist; it resolves as soon as source lands.
