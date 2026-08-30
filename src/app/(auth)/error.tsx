'use client'

import Link from 'next/link'
import { Button, ErrorState, buttonClasses } from '@/components/ui'

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <ErrorState
      title="This page did not load"
      description="Something failed while loading this form. Trying again often clears it."
      {...(error.digest ? { errorId: error.digest } : {})}
    >
      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
      <Link href="/" className={buttonClasses('secondary', 'md')}>
        Back to home
      </Link>
    </ErrorState>
  )
}
