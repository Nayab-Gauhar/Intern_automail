import { NextResponse, type NextRequest } from 'next/server'

/**
 * NOT A SECURITY BOUNDARY.
 *
 * This file performs exactly one job: if a request for an authenticated route arrives
 * with no session cookie at all, redirect to /login instead of rendering a shell that
 * would immediately redirect anyway. That is a UX optimisation and nothing more.
 *
 * The REAL authentication check is `requireWorkspace()` in src/app/(app)/layout.tsx,
 * and again at the top of every server action (via the `action()` wrapper) and every
 * route handler. Those validate the session token against the database, check that it
 * is neither revoked nor expired, and resolve workspace membership and role.
 *
 * A PRESENT cookie is NOT treated as authentication here. Anyone can set a cookie; a
 * forged or expired one sails through this file by design and is rejected by the
 * layout. Deleting this file must not grant access to anything — if it ever does,
 * that is the bug, not a missing middleware rule.
 *
 * Do not add a database call here. See docs/architecture/07-auth-and-security.md §11:
 * middleware runs on every matched request including prefetches, so a query here
 * multiplies database load for no security benefit the layout does not already provide.
 *
 * Next 16 runs middleware on the Node runtime by default, so no runtime export is needed.
 */

/**
 * Must match the cookie name set by src/server/session.ts. The __Host- prefix in
 * production requires Secure, host-only, and path=/ — a browser rejects the cookie
 * outright otherwise, which is the point of using it.
 */
const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-im_session' : 'im_session'

/** The (app) route group's URL prefixes. The group name itself never appears in a URL. */
const APP_PREFIXES = [
  '/dashboard',
  '/inbox',
  '/leads',
  '/campaigns',
  '/mailboxes',
  '/crm',
  '/analytics',
  '/ai',
  '/deliverability',
  '/settings',
  '/onboarding',
] as const

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl

  const isAppRoute = APP_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )

  if (isAppRoute && !req.cookies.has(SESSION_COOKIE)) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    // Round-trip the intended destination so the user lands where they meant to.
    // The login page validates this is a local path before honouring it — an
    // attacker-supplied absolute URL here would otherwise be an open redirect.
    url.searchParams.set('next', `${pathname}${search}`)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  /**
   * Skip static assets, image optimisation, and every API route. API handlers do their
   * own authentication and must return JSON 401s, not an HTML redirect — several are
   * called by Google (webhooks, OAuth callback) or a cron (worker tick) and would
   * break if bounced to a login page.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)'],
}
