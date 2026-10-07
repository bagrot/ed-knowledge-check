import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://saqyefbqirzdpzbtoxih.supabase.co";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async headers() {
    const csp = [
      "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'",
      "form-action 'self'", "img-src 'self' data: blob:", "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'", "worker-src 'self' blob:", "upgrade-insecure-requests",
    ].join('; ');
    return [{ source: '/:path*', headers: [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
  async rewrites() {
    return [{ source: "/supabase/:path*", destination: `${supabaseUrl}/:path*` }];
  },
};

export default nextConfig;
