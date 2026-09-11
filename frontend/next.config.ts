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
      {
        // Next serves everything in public/ with "max-age=0, must-revalidate",
        // which is fine for HTML and wrong for a 10MB hero reel: the browser
        // re-validates it on every single visit and re-pulls the whole file
        // whenever the edge cache is cold. That is why the scroll hero feels
        // smooth one day and sticky the next — it was never actually cached.
        //
        // Long max-age, but deliberately NOT "immutable": these filenames are
        // not content-hashed, and immutable would pin a stale reel in returning
        // visitors' browsers forever. stale-while-revalidate lets a re-cut
        // propagate in the background. If the reel is ever replaced, bump the
        // filename rather than relying on this window.
        source: "/:dir(v2)/:file*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=2592000, stale-while-revalidate=86400" },
        ],
      },
      {
        source: "/:file(reel-hd.mp4|reel-sd.mp4|reel-opt.mp4|reel.mp4|reel-poster.jpg)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=2592000, stale-while-revalidate=86400" },
        ],
      },
    ];
  },
  // Home swap: serve the cinematic scroll-reel landing at "/". beforeFiles runs
  // ahead of filesystem routing so it wins over the old React landing at
  // app/page.tsx, which stays in place but is dead code.
  //
  // Two static landings live in public/. home-v2.html is current: the brick-house
  // "damaged to done" reel. home.html is the previous white-house cut, kept as a
  // one-line rollback — point destination back at it and redeploy.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/home-v2.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
