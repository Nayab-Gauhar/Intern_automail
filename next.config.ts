import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Fail the production build on type errors. Being explicit means a future
  // config edit cannot silently weaken CI.
  //
  // There is deliberately no `eslint` key: Next 16 removed both `next lint` and
  // the config's eslint integration, so linting is a separate CI step running
  // `eslint .` directly.
  typescript: { ignoreBuildErrors: false },

  // `pg` and the Prisma adapter are native/server-only; keep them out of any
  // bundling attempt so a stray client import fails loudly at build instead of
  // shipping a broken chunk.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg'],

  // Security headers. CSP is deliberately omitted here and applied per-response
  // in middleware, where a per-request nonce can be attached — a static CSP
  // would force 'unsafe-inline' for Next's hydration scripts.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ]
  },
}

export default nextConfig
