import type { Metadata } from 'next'
import { Users } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'Leads' }

export default function LeadsPage() {
  return (
    <StubPage
      title="Leads"
      description="Your prospect records: fields, tags, lists, and the campaigns each lead is enrolled in."
      icon={Users}
      heading="Leads are not built yet"
      detail="This will be a server-paginated lead table with filters and sort held in the URL, streamed CSV import and export, per-lead profiles with a full activity timeline, and lead lists. It arrives in the leads slice."
    />
  )
}
