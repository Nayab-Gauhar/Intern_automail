'use client'

import Link from 'next/link'
import { Button, ErrorState, buttonClasses } from '@/components/ui'
import { PageBody } from '@/components/patterns/page-header'

/**
 * The in-shell error boundary. It sits inside `(app)/layout.tsx`, so the sidebar and top
 * bar stay rendered and usable — a failed page must not strand the user with no way to
 * navigate anywhere else.
 *
 * We show `error.digest`, not `error.message`: Next redacts server error messages in
 * production, and the digest is the id that correlates to the logged stack.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <PageBody className="pt-10">
      <ErrorState
        title="This page did not load"
        description="Something failed while loading this section. Trying again often clears it. Your other sections are unaffected."
        {...(error.digest ? { errorId: error.digest } : {})}
      >
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link href="/dashboard" className={buttonClasses('secondary', 'md')}>
          Go to dashboard
        </Link>
      </ErrorState>
    </PageBody>
  )
}
