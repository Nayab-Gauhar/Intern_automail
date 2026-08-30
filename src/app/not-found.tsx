import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { EmptyState, buttonClasses } from '@/components/ui'

/**
 * The global 404 — reached for a URL that matches no route at all. The in-shell 404
 * (which is also the response for a cross-workspace access attempt, per brief §4
 * rule 5) is a separate file inside the (app) group so the nav stays usable.
 */
export default function NotFound() {
  return (
    <main className="gutter-x flex min-h-dvh items-center justify-center">
      <EmptyState
        kind="no-results"
        icon={FileQuestion}
        title="Page not found"
        description="That URL does not match anything here. It may have moved, or the link may be incomplete."
      >
        <Link href="/" className={buttonClasses('primary', 'md')}>
          Back to home
        </Link>
      </EmptyState>
    </main>
  )
}
