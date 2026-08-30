import type { Metadata } from 'next'
import { Send } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'Campaigns' }

export default function CampaignsPage() {
  return (
    <StubPage
      title="Campaigns"
      description="Multi-step sequences, the leads enrolled in them, and their sending schedules."
      icon={Send}
      heading="Campaigns are not built yet"
      detail="This will cover campaign creation, lead assignment, the sequence builder with personalisation and variable-coverage checks, sending windows and per-mailbox caps, and launch and pause controls. It arrives in the campaigns slice."
    />
  )
}
