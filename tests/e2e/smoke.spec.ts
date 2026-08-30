import { test, expect } from '@playwright/test'

/**
 * Smoke tests: the app boots, the landing page renders, and protected routes
 * actually redirect. Deliberately narrow — the full happy path
 * (connect mailbox → import lead → campaign → sequence → launch → send → reply
 * → sequence stops → reply in inbox) lands with the features it exercises.
 *
 * These run first because a failure here means every richer test is noise.
 */

test('landing page renders and offers a way in', async ({ page }) => {
  await page.goto('/')

  // One h1, and it says something. Editorial layouts are easy to ship headless.
  const h1 = page.locator('h1')
  await expect(h1).toHaveCount(1)
  await expect(h1).not.toBeEmpty()

  // A visitor must be able to reach authentication from the landing page.
  await expect(page.getByRole('link', { name: /sign in|log ?in/i }).first()).toBeVisible()
})

test('an unauthenticated visitor cannot reach the dashboard', async ({ page }) => {
  await page.goto('/dashboard')

  // The redirect target is the assertion: reaching the dashboard unauthenticated
  // would be a workspace-isolation failure, not a cosmetic bug.
  await expect(page).toHaveURL(/\/(login|register)(\?|$)/)
})

test('the login page is keyboard operable and correctly labelled', async ({ page }) => {
  await page.goto('/login')

  // Real <label>s, not placeholder-as-label: getByLabel fails on the latter.
  const email = page.getByLabel(/email/i)
  const password = page.getByLabel(/password/i)
  await expect(email).toBeVisible()
  await expect(password).toBeVisible()

  // Password must never be a text input, regardless of styling.
  await expect(password).toHaveAttribute('type', 'password')

  // Tab must reach the submit control without a mouse.
  await email.focus()
  await page.keyboard.press('Tab')
  await expect(password).toBeFocused()
})

test('a bad login fails cleanly without revealing whether the account exists', async ({ page }) => {
  // Collect server-side failures. The first version of this test asserted only
  // "an alert appears that does not say no-such-user" — which a 500 error page
  // also satisfies. It passed green while login was throwing "auth requires the
  // Bun runtime" on every attempt. Assert the absence of a server error
  // explicitly, or the test cannot distinguish a working rejection from a crash.
  const serverErrors: string[] = []
  page.on('response', (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`)
  })
  page.on('pageerror', (e) => serverErrors.push(`pageerror: ${e.message}`))

  await page.goto('/login')
  await page.getByLabel(/email/i).fill('definitely-not-registered@example.com')
  await page.getByLabel(/password/i).fill('wrong-password-value')
  await page.getByRole('button', { name: /sign in|log ?in/i }).click()

  // A rejection must reach the user...
  await expect(page.getByRole('alert')).toBeVisible()

  // ...as an application error, not a crash.
  expect(serverErrors).toEqual([])

  // ...and must not disclose which half was wrong. Enumeration is the
  // vulnerability under test.
  await expect(page.getByRole('alert')).not.toContainText(
    /no (such )?(user|account)|not (found|registered)|unknown email|went wrong|unexpected/i,
  )
})

test('the demo account can sign in and reach the dashboard', async ({ page }) => {
  // The end-to-end proof that authentication actually works. Without it, every
  // other test here passes against a login form that throws on submit.
  const serverErrors: string[] = []
  page.on('response', (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`)
  })

  await page.goto('/login')
  await page.getByLabel(/email/i).fill('owner@acme.test')
  await page.getByLabel(/password/i).fill('instant-mail-demo-2026')
  await page.getByRole('button', { name: /sign in|log ?in/i }).click()

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
  expect(serverErrors).toEqual([])
  await expect(page.getByRole('navigation')).toBeVisible()
})
