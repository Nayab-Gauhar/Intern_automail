import type { Metadata } from 'next'
import { Target } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'CRM' }

export default function CrmPage() {
  return (
    <StubPage
      title="CRM"
      description="Opportunities, pipeline stages, tasks, and notes created from positive replies."
      icon={Target}
      heading="The CRM is not built yet"
      detail="This will be a pipeline board by stage, an opportunities table over the same records, and tasks grouped by when they are due. Opportunities are created from replies the AI classifies as interested. It arrives in the CRM slice."
    />
  )
}
