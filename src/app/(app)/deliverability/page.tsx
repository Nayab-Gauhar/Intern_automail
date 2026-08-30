import type { Metadata } from 'next'
import { ShieldCheck } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'Deliverability' }

export default function DeliverabilityPage() {
  return (
    <StubPage
      title="Deliverability"
      description="SPF, DKIM, and DMARC records, mailbox warmup, and your suppression list."
      icon={ShieldCheck}
      heading="Deliverability is not built yet"
      detail="This will show the DNS records each sending domain needs with the values to copy, warmup schedules and ramp curves, and a searchable suppression list. It will make no claim about inbox-versus-spam placement, which we cannot observe. It arrives in the advanced slice."
    />
  )
}
