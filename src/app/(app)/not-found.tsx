import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { EmptyState, buttonClasses } from '@/components/ui'
import { PageBody } from '@/components/patterns/page-header'

/**
 * The in-shell 404. This is also the response for a cross-workspace access attempt:
 * brief §4 rule 5 requires 404 rather than 403, because a 403 confirms that the resource
 * exists in someone else's workspace. The copy is therefore deliberately identical for
 * both cases — "not found" must not become an existence oracle.
 */
export default function AppNotFound() {
  return (
    <PageBody className="pt-10">
      <EmptyState
        kind="no-results"
        icon={FileQuestion}
        title="Not found"
        description="This page does not exist, or it is not part of your workspace."
      >
        <Link href="/dashboard" className={buttonClasses('primary', 'md')}>
          Go to dashboard
        </Link>
      </EmptyState>
    </PageBody>
  )
}
