import type { NextConfig } from 'next';

// v10: baseline Content-Security-Policy. Route handlers that serve untrusted
// content (/preview/*, /api/media/assets/*) set their own stricter CSP on the
// response; the browser enforces every policy present, so the stricter one
// always wins there. script-src keeps 'unsafe-inline' because Next.js hydrates
// with inline bootstrap scripts; AI-generated content is rendered through React
// (streamdown), never through script execution.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "media-src 'self' blob: data:",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  serverExternalPackages: ['better-auth', 'node:sqlite'],
  async headers() {
    // HSTS only when the deployment is actually behind TLS: the app knows its
    // public URL, so derive it instead of guessing. Local http://localhost
    // development never sends it.
    const publicUrl = process.env.BETTER_AUTH_URL || '';
    const hsts =
      process.env.HIKMAH_HSTS === '0'
        ? []
        : publicUrl.startsWith('https://')
          ? [
              {
                key: 'Strict-Transport-Security',
                value: 'max-age=63072000; includeSubDomains',
              },
            ]
          : [];
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
          // Microphone is deliberately NOT restricted: voice dictation needs it.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), geolocation=(), payment=()',
          },
          ...hsts,
        ],
      },
    ];
  },
};

export default nextConfig;
