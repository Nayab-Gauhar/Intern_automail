import type { Metadata } from 'next'
import { Sparkles } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'AI' }

export default function AiPage() {
  return (
    <StubPage
      title="AI"
      description="Reply classification, thread summaries, suggested drafts, and personalisation runs."
      icon={Sparkles}
      heading="AI features are not built yet"
      detail="AI here is assistive and always attributed: it classifies replies, summarises threads, drafts responses for a human to approve, and personalises at scale. Outputs are validated and stored with the model, version, and confidence. No substantive reply is ever sent autonomously. It arrives in the AI slice."
    />
  )
}
