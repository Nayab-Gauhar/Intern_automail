import type { Metadata } from 'next'
import { Inbox, Send, Sparkles, Users } from 'lucide-react'
import { EmptyState, Panel, PanelBody } from '@/components/ui'
import { PageBody, PageHeader, Section } from '@/components/patterns/page-header'
import { StatCard, StatCardRow } from '@/components/patterns/stat-card'

/**
 * The attention-first dashboard (frontend spec §4).
 *
 * The spec's seven sections each await exactly one module call —
 * `dashboard.problems`, `dashboard.counts`, `dashboard.needsReply`,
 * `dashboard.campaignHealth`, `dashboard.mailboxHealth`, the 30-day trend, and
 * `dashboard.activity`. **None of those modules exists yet**, and `src/modules/` has not
 * been created, so there is nothing to query. Lint rule 1 forbids this page reaching
 * around them into Prisma, and the brief forbids inventing numbers.
 *
 * So every card here renders its honest unavailable state, with the reason spelled out.
 * `StatCard`'s `unavailable` prop exists precisely for this: it shows an em dash and a
 * reason rather than a zero, because "0 replies waiting" and "we could not count
 * replies" are different facts and conflating them is how a broken pipeline reads as a
 * calm one.
 *
 * There is no <Suspense> here yet. A boundary whose child is synchronous never
 * suspends, so wrapping these cards would be decoration. The boundaries arrive with the
 * async section components, in the same change that gives them something to await.
 *
 * The triage banner is absent rather than empty — per §4.3.1 the absence of the banner
 * IS the healthy state, and there is deliberately no "all good" card.
 */

export const metadata: Metadata = { title: 'Dashboard' }

const UNBUILT = 'Not available yet'

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Triage first: replies waiting, campaigns that need unsticking, mailboxes that need attention."
      />

      <PageBody>
        <Section
          title="Needs attention"
          description="Counts come from the leads, inbox, CRM, and analytics modules. None of them is built yet, so these read as unavailable rather than zero."
        >
          <StatCardRow>
            <StatCard
              label="Replies waiting"
              context="Unread threads with an inbound message"
              unavailable={UNBUILT}
            />
            <StatCard
              label="Interested leads"
              context="Classified interested, with no opportunity yet"
              unavailable={UNBUILT}
            />
            <StatCard
              label="Follow-ups due"
              context="Incomplete tasks due today or earlier"
              unavailable={UNBUILT}
            />
            <StatCard
              label="Failed sends"
              context="Send failures in the last 24 hours"
              unavailable={UNBUILT}
            />
          </StatCardRow>
        </Section>

        <Section title="Needs a reply">
          <Panel>
            <PanelBody>
              <EmptyState
                kind="not-built"
                as="h3"
                icon={Inbox}
                title="The inbox is not built yet"
                description="This will list the five oldest unread inbound threads, oldest first, each linking straight into the conversation."
              />
            </PanelBody>
          </Panel>
        </Section>

        <Section title="Campaign health">
          <Panel>
            <PanelBody>
              <EmptyState
                kind="not-built"
                as="h3"
                icon={Send}
                title="Campaigns are not built yet"
                description="This will show each campaign's status, sends, reply rate, and next scheduled send — with the reply rate suppressed below twenty sends rather than shown on a sample too small to mean anything."
              />
            </PanelBody>
          </Panel>
        </Section>

        <Section title="Mailboxes">
          <Panel>
            <PanelBody>
              <EmptyState
                kind="not-built"
                as="h3"
                icon={Users}
                title="Mailboxes are not built yet"
                description="This will show each mailbox's status, today's volume against its daily cap, warmup day, and last sync."
              />
            </PanelBody>
          </Panel>
        </Section>

        <Section
          title="Recent activity"
          description="Sends, replies, bounces, classifications, launches, and imports, newest first."
        >
          <Panel>
            <PanelBody>
              <EmptyState
                kind="not-built"
                as="h3"
                icon={Sparkles}
                title="No activity to show"
                description="Activity is derived from the append-only email event log, which nothing writes to until the sending engine lands."
              />
            </PanelBody>
          </Panel>
        </Section>
      </PageBody>
    </>
  )
}
