'use client'

import { useActionState } from 'react'
import { Button, Field, FormMessage, Input } from '@/components/ui'
import { fieldError } from '../field-error'
import { registerAction, type AuthFormState } from '../actions'

/**
 * The registration form. Same shape as the login form and for the same reasons — the
 * zod schema on the server is the single validation authority, so there is no client
 * resolver to drift from it.
 *
 * The password hint states the real rule up front rather than only after a rejected
 * submit. The server additionally rejects a password containing the user's own name or
 * email; that check needs the other fields, so it surfaces as a field error rather than
 * as a static hint.
 */
export function RegisterForm() {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(registerAction, null)

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormMessage>{state?.message}</FormMessage>

      <Field label="Your name" htmlFor="name" required {...fieldError(state?.fieldErrors?.name)}>
        {(control) => (
          <Input
            {...control}
            name="name"
            type="text"
            autoComplete="name"
            autoFocus
            placeholder="Alex Fenwick"
          />
        )}
      </Field>

      <Field label="Work email" htmlFor="email" required {...fieldError(state?.fieldErrors?.email)}>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
          />
        )}
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        hint="At least 12 characters. Length matters more than punctuation."
        {...fieldError(state?.fieldErrors?.password)}
      >
        {(control) => (
          <Input {...control} name="password" type="password" autoComplete="new-password" />
        )}
      </Field>

      <Field
        label="Workspace name"
        htmlFor="workspaceName"
        optional
        hint="Usually your company. Defaults to your name if you leave it blank."
        {...fieldError(state?.fieldErrors?.workspaceName)}
      >
        {(control) => (
          <Input
            {...control}
            name="workspaceName"
            type="text"
            autoComplete="organization"
            placeholder="Acme Outreach"
          />
        )}
      </Field>

      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
