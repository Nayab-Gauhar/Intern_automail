import type { Metadata } from 'next'
import { Mail } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'Mailboxes' }

export default function MailboxesPage() {
  return (
    <StubPage
      title="Mailboxes"
      description="The real mailboxes your campaigns send from, and the health of each one."
      icon={Mail}
      heading="Mailboxes are not built yet"
      detail="This will let you connect a Gmail mailbox over OAuth, with refresh tokens encrypted at rest, and show each mailbox's status, daily cap and usage, sending window, signature, and recent errors. It arrives in the mailboxes slice, which is the next one."
    />
  )
}
