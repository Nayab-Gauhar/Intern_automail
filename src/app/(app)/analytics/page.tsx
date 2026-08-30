import type { Metadata } from 'next'
import { ChartNoAxesColumn } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'Analytics' }

export default function AnalyticsPage() {
  return (
    <StubPage
      title="Analytics"
      description="Sends, replies, bounces, and per-step performance, derived from the email event log."
      icon={ChartNoAxesColumn}
      heading="Analytics is not built yet"
      detail="Every metric here derives from the append-only email event log rather than from cached counters. Open rates will be labelled indicative because many clients block tracking pixels, and comparisons will be suppressed below a usable sample size rather than shown on noise. It arrives in the analytics slice."
    />
  )
}
