import type { Metadata } from 'next'
import { Inbox } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'Inbox' }

export default function InboxPage() {
  return (
    <StubPage
      title="Inbox"
      description="Conversations with your leads, with replies detected and classified automatically."
      icon={Inbox}
      heading="The inbox is not built yet"
      detail="This will be a three-pane inbox: folders, a thread list driven entirely by the URL, and the conversation itself with a reply composer. Inbound email is rendered in a sandboxed frame after server-side sanitising. It arrives in the inbox slice, once mailbox sync can populate it."
    />
  )
}
