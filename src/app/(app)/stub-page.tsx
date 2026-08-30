import type { LucideIcon } from 'lucide-react'
import { EmptyState, Panel, PanelBody } from '@/components/ui'
import { PageBody, PageHeader } from '@/components/patterns/page-header'

/**
 * The shared body of every not-yet-built section.
 *
 * These pages exist so the sidebar never leads to a blank screen or a 404 — a nav item
 * that 404s reads as a broken app rather than an unfinished one. Each states which
 * phase owns it and what will live there, and renders no controls at all: the
 * `not-built` empty state drops any action passed to it precisely so a stub cannot grow
 * a fake button.
 *
 * Delete each call site as its slice lands. Nothing else imports this file.
 */
export function StubPage({
  title,
  description,
  icon,
  heading,
  detail,
}: {
  title: string
  /** Sits under the <h1>: what this section will do once built. */
  description: string
  icon: LucideIcon
  /** The empty state's own headline. */
  heading: string
  /** What will be here, concretely, and which slice delivers it. */
  detail: string
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <PageBody>
        <Panel>
          <PanelBody>
            <EmptyState kind="not-built" icon={icon} title={heading} description={detail} />
          </PanelBody>
        </Panel>
      </PageBody>
    </>
  )
}
