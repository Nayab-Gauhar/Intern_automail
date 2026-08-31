import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * Guards the package scripts that must run under the Bun runtime.
 *
 * `src/modules/auth/service.ts` uses `Bun.password` for argon2id. The `next` binary's
 * shebang is `#!/usr/bin/env node`, so any script invoking `next` without `bun --bun`
 * serves the app under Node, where the global is absent and **every login throws**.
 *
 * This test exists because that bug was fixed in `start` and the Playwright config
 * but missed in `dev` — so the app worked in CI and in the E2E suite while being
 * broken for anyone actually developing against it. A test on the scripts catches
 * the whole class at once, rather than one runtime at a time.
 */

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}

/**
 * Scripts that boot the app and therefore reach the password primitives.
 * Not `as const`: test.each rejects a readonly tuple.
 */
const MUST_USE_BUN: string[] = ['dev', 'start']

describe('scripts that serve the app run under Bun', () => {
  test.each(MUST_USE_BUN)('%s uses `bun --bun`', (name) => {
    const cmd = pkg.scripts[name]
    expect(cmd).toBeDefined()
    expect(cmd).toContain('bun --bun')
  })

  test('the node-runtime escape hatches are kept, and clearly named', () => {
    // Deliberately retained for debugging a Node-specific difference; the `:node`
    // suffix is what stops someone reaching for them by accident.
    for (const name of ['dev:node', 'start:node']) {
      expect(pkg.scripts[name]).toBeDefined()
      expect(pkg.scripts[name]).not.toContain('bun --bun')
    }
  })
})

describe('test scripts carry the flags they need', () => {
  test.each(['test', 'test:unit', 'test:integration'])(
    '%s resolves the react-server condition',
    (name) => {
      // lib/{env,db,crypto}.ts import "server-only", which throws unless the
      // react-server export condition resolves.
      expect(pkg.scripts[name]).toContain('--conditions react-server')
    },
  )

  test.each(['test', 'test:unit'])('%s preloads the shared env preamble', (name) => {
    // Without it, whichever test file imports env.ts first fixes configuration for
    // the whole run, and the suite passes or fails on file ordering.
    expect(pkg.scripts[name]).toContain('--preload ./tests/unit-env.ts')
  })
})

describe('the Playwright web server runs under Bun too', () => {
  const config = readFileSync(new URL('../../playwright.config.ts', import.meta.url), 'utf8')

  test('its command uses `bun --bun`', () => {
    expect(config).toMatch(/command:.*bun --bun next start/)
  })

  test('it does not claim to be production', () => {
    // In production the cookie is `__Host-im_session` with Secure, which browsers
    // reject over the plain http test server — login then appears to succeed while
    // the session cookie is silently dropped.
    expect(config).toMatch(/NODE_ENV:\s*'test'/)
    expect(config).not.toMatch(/NODE_ENV:\s*'production'/)
  })
})
