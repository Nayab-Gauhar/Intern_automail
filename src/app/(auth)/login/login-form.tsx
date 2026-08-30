'use client'

import { useActionState } from 'react'
import { Button, Field, FormMessage, Input } from '@/components/ui'
import { fieldError } from '../field-error'
import { loginAction, type AuthFormState } from '../actions'

/**
 * The sign-in form.
 *
 * `useActionState` (React 19) rather than `react-hook-form`: the validation authority is
 * the zod schema on the server, and this form has no client-side rules of its own to
 * enforce. Adding a resolver here would duplicate the schema and let the two drift.
 * `useFormStatus` is not needed either — `useActionState` returns `pending` directly.
 *
 * The form works without JavaScript: `<form action={fn}>` posts to the action, and the
 * server re-renders with the returned state.
 *
 * `FormMessage` carries role="status" and aria-live="polite" internally, so a failed
 * submit is announced without moving focus away from where the user is typing.
 */
export function LoginForm({ next }: { next?: string | undefined }) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(loginAction, null)

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormMessage>{state?.message}</FormMessage>

      <Field label="Email" htmlFor="email" required {...fieldError(state?.fieldErrors?.email)}>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="email"
            // The one field worth focusing on arrival; nothing above it to skip.
            autoFocus
            placeholder="you@company.com"
          />
        )}
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        {...fieldError(state?.fieldErrors?.password)}
      >
        {(control) => (
          <Input {...control} name="password" type="password" autoComplete="current-password" />
        )}
      </Field>

      {/*
        Round-tripped so a user bounced here from a deep link lands back on it. The
        action passes it through `safeNext()`, which rejects anything that is not a
        same-origin absolute path — `//evil.example` and `https://evil.example` are
        both open redirects, and this value is attacker-supplied.
      */}
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
