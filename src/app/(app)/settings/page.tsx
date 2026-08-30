import type { Metadata } from 'next'
import { Settings } from 'lucide-react'
import { StubPage } from '../stub-page'

export const metadata: Metadata = { title: 'Settings' }

export default function SettingsPage() {
  return (
    <StubPage
      title="Settings"
      description="Your profile, the workspace, members and roles, security, and API keys."
      icon={Settings}
      heading="Settings are not built yet"
      detail="This will hold your profile and timezone, workspace name and sending defaults, member roles and invitations, password changes and active session revocation, API keys, and the audit log. Sub-pages are filtered by role, and the server enforces that independently of what the navigation shows. It arrives with the workspace slice."
    />
  )
}
