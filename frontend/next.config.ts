import type { NextConfig } from "next";

// Security headers everywhere — EXCEPT the /q quote widget, which contractors
// embed in iframes on their own domains (framing is the product there).
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(self), payment=()" },
];

const nextConfig: NextConfig = {
  generateBuildId: async () => {
    return `build-${Date.now()}`
  },
  async headers() {
    return [
      {
        // every route except /q/** (embeddable widget)
        source: "/((?!q/).*)",
        headers: securityHeaders,
      },
      {
        source: "/q/:path*",
        headers: securityHeaders.filter(h => h.key !== "X-Frame-Options"),
      },
    ];
  },
  // Home swap (temporary): serve the cinematic scroll-reel landing (public/home.html)
  // at "/". beforeFiles runs ahead of filesystem routing so it wins over the old
  // React landing at app/page.tsx, which stays in place so this is a one-line revert.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/home.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
