import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession, safeNext } from '@/server/session'
import { LoginForm } from './login-form'

/**
 * Sign in.
 *
 * A signed-in visitor is sent to their destination rather than shown a login form for an
 * account they already hold. `safeNext()` validates the target before we honour it.
 */

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const target = safeNext(next)

  if (await getSession()) redirect(target)

  return (
    <>
      <h1 className="font-display text-display-md text-ink">Sign in</h1>
      <p className="text-body-sm text-ink-secondary mt-2">
        Reach your workspace, campaigns, and inbox.
      </p>

      <div className="mt-8">
        {/* Pass the raw value through: the action re-validates it with safeNext(). */}
        <LoginForm next={next} />
      </div>

      <p className="text-body-sm text-ink-secondary mt-8">
        No account?{' '}
        <Link href="/register" className="text-accent underline underline-offset-4">
          Create one
        </Link>
      </p>
    </>
  )
}
