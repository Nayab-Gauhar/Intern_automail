/**
 * Turns a possibly-absent message into props for `Field`.
 *
 * `tsconfig` sets `exactOptionalPropertyTypes`, so `error={maybeUndefined}` is a type
 * error even though `error` is optional: the flag distinguishes "absent" from "present
 * and undefined". Spreading the result of this keeps the key off the object entirely
 * when there is no message.
 *
 * A plain module, not part of `actions.ts` — a `'use server'` file may only export
 * async functions.
 */
export function fieldError(message: string | undefined): { error?: string } {
  return message ? { error: message } : {}
}
