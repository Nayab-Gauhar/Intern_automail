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
