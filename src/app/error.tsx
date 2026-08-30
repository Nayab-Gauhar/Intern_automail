'use client'

import Link from 'next/link'
import { Button, ErrorState, buttonClasses } from '@/components/ui'

/**
 * Root error boundary. Client component by requirement — Next needs `reset` to be a
 * callable passed across the boundary.
 *
 * `error.digest` is the server-side correlation id Next generates when a Server
 * Component throws; the message itself is redacted in production, which is why the
 * digest is the thing worth showing. We surface it as the support reference rather
 * than rendering `error.message`, which would leak internals in development and be
 * useless in production.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="gutter-x flex min-h-dvh items-center justify-center">
      <ErrorState
        title="Something went wrong"
        description="This page failed to load. Trying again often clears it. If it keeps happening, quote the reference below."
        {...(error.digest ? { errorId: error.digest } : {})}
      >
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link href="/" className={buttonClasses('secondary', 'md')}>
          Back to home
        </Link>
      </ErrorState>
    </main>
  )
}
