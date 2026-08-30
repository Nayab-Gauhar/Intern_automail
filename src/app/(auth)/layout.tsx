import type { ReactNode } from 'react'
import Link from 'next/link'

/**
 * The auth chrome: a centred column on the warm ground.
 *
 * The already-signed-in redirect lives in each PAGE rather than here, because /login
 * must honour `?next=` and a layout cannot read `searchParams` — a Next constraint, not
 * a preference. Putting it here would silently drop the deep link a user was bounced
 * from.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-border border-b">
        <div className="gutter-x mx-auto flex h-[60px] max-w-[1280px] items-center">
          <Link href="/" className="font-display text-heading text-ink rounded-sm">
            Instant Mail
          </Link>
        </div>
      </header>

      <main id="main" className="flex flex-1 items-start justify-center px-5 py-12 md:py-20">
        <div className="w-full max-w-[440px]">{children}</div>
      </main>
    </div>
  )
}
