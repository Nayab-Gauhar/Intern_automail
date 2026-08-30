import type { Metadata } from 'next'
import Link from 'next/link'
import { buttonClasses } from '@/components/ui'

/**
 * The public landing page.
 *
 * Deliberately short, and deliberately free of the things we cannot support: no
 * testimonials, no customer logos, no invented metrics, no "10x your pipeline". It
 * states what the system does and how it behaves, because the honest description of
 * the core loop is more persuasive to the audience for this product than adjectives.
 *
 * Static — no session read, no database. A signed-in user visiting `/` sees this and
 * uses the Sign in link; we do not redirect, because a marketing page that bounces
 * you to a dashboard is hostile when you wanted the marketing page.
 */

export const metadata: Metadata = {
  title: 'Instant Mail — outreach that runs without you watching',
  description:
    'Multi-step cold email sequences sent from your own mailboxes. Replies are detected, sequences stop automatically, and nothing sends twice.',
}

/** The product's actual mechanics, stated plainly. Each one is a real invariant. */
const MECHANICS = [
  {
    title: 'Sends without a browser open',
    body: 'A standalone worker process drives every send. Campaigns keep running whether or not anyone is signed in.',
  },
  {
    title: 'A reply stops the sequence',
    body: 'When a human replies, the remaining steps for that lead are halted — promptly, and without duplicating the stop.',
  },
  {
    title: 'Never the same email twice',
    body: 'Every send is idempotent under retries, worker restarts, and concurrent workers. Duplicate delivery is a database-level impossibility, not a hope.',
  },
  {
    title: 'Limits that actually hold',
    body: 'Daily caps and sending windows are enforced per mailbox, in the mailbox timezone. Nothing leaks out at 3am.',
  },
  {
    title: 'AI drafts, you send',
    body: 'Replies are classified and drafts suggested, attributed as AI-generated. A person approves before anything substantive goes out.',
  },
  {
    title: 'Honest reporting',
    body: 'Open tracking is labelled indicative because it is blocked by many clients. Comparisons are suppressed below a usable sample size rather than dressed up.',
  },
] as const

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-border border-b">
        <div className="gutter-x mx-auto flex h-[60px] max-w-[1280px] items-center justify-between">
          <span className="font-display text-heading text-ink">Instant Mail</span>
          <nav aria-label="Account" className="flex items-center gap-2">
            <Link href="/login" className={buttonClasses('ghost', 'sm')}>
              Sign in
            </Link>
            <Link href="/register" className={buttonClasses('primary', 'sm')}>
              Create account
            </Link>
          </nav>
        </div>
      </header>

      <main id="main" className="flex-1">
        <section className="gutter-x mx-auto max-w-[1280px] pt-20 pb-16 md:pt-28 md:pb-24">
          <div className="max-w-3xl">
            <h1 className="font-display text-display-lg md:text-display-xl text-ink">
              Cold outreach that keeps running when you close the tab.
            </h1>
            <p className="text-body text-ink-secondary mt-6 max-w-[60ch]">
              Instant Mail takes a list of leads through multi-step, personalised email sequences
              sent from your own mailboxes. It watches for replies, stops sequences when someone
              answers, classifies what they said, and turns the good ones into opportunities.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/register" className={buttonClasses('primary', 'lg')}>
                Create an account
              </Link>
              <Link href="/login" className={buttonClasses('secondary', 'lg')}>
                Sign in
              </Link>
            </div>
          </div>
        </section>

        <section aria-labelledby="loop-heading" className="border-border bg-bg-subtle border-y">
          <div className="gutter-x mx-auto max-w-[1280px] py-14">
            <h2 id="loop-heading" className="text-micro text-ink-meta uppercase">
              The loop
            </h2>
            <p className="font-display text-display-md text-ink mt-4 max-w-[42ch]">
              Lead, sequence, send, reply, opportunity — closed, and running unattended.
            </p>
            <ol className="text-body-sm text-ink-secondary mt-8 grid gap-x-10 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <li>
                <span className="text-label text-ink">1. Import leads</span> — CSV or manual entry,
                deduplicated per workspace.
              </li>
              <li>
                <span className="text-label text-ink">2. Build a sequence</span> — steps, delays,
                and personalisation with variable coverage checked before launch.
              </li>
              <li>
                <span className="text-label text-ink">3. Connect a mailbox</span> — Gmail via OAuth.
                Refresh tokens are encrypted at rest.
              </li>
              <li>
                <span className="text-label text-ink">4. Launch</span> — the scheduler materialises
                sends; the worker delivers them inside your caps and windows.
              </li>
              <li>
                <span className="text-label text-ink">5. Replies land</span> — detected, associated
                to the lead, and the sequence stops.
              </li>
              <li>
                <span className="text-label text-ink">6. Pipeline</span> — positive replies become
                opportunities and tasks in the CRM.
              </li>
            </ol>
          </div>
        </section>

        <section
          aria-labelledby="mechanics-heading"
          className="gutter-x mx-auto max-w-[1280px] py-16 md:py-20"
        >
          <h2 id="mechanics-heading" className="text-micro text-ink-meta uppercase">
            How it behaves
          </h2>
          <dl className="mt-8 grid gap-x-12 gap-y-9 md:grid-cols-2 lg:grid-cols-3">
            {MECHANICS.map((item) => (
              <div key={item.title}>
                <dt className="text-subheading text-ink">{item.title}</dt>
                <dd className="text-body-sm text-ink-secondary mt-2">{item.body}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="border-border border-t">
        <div className="gutter-x text-caption text-ink-meta mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 py-8">
          <p>Instant Mail — an original implementation. You supply the mailboxes and the list.</p>
          <p>All timestamps are stored in UTC.</p>
        </div>
      </footer>
    </div>
  )
}
