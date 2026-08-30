import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/server/session'
import { RegisterForm } from './register-form'

/**
 * Create an account. Registering also creates the user's first workspace and makes them
 * its OWNER, which is why the form asks for a workspace name.
 */

export const metadata: Metadata = { title: 'Create account' }

export default async function RegisterPage() {
  if (await getSession()) redirect('/dashboard')

  return (
    <>
      <h1 className="font-display text-display-md text-ink">Create your account</h1>
      <p className="text-body-sm text-ink-secondary mt-2">
        This also creates your first workspace. You can invite people to it later.
      </p>

      <div className="mt-8">
        <RegisterForm />
      </div>

      <p className="text-body-sm text-ink-secondary mt-8">
        Already have an account?{' '}
        <Link href="/login" className="text-accent underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </>
  )
}
