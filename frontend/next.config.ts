import type { NextConfig } from "next";

// Security headers everywhere — EXCEPT the /q quote widget, which contractors
// embed in iframes on their own domains (framing is the product there).
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // payment=() blocks the Payment Request API. Correct everywhere that does
  // not take money, and it stays the default for exactly that reason.
  { key: "Permissions-Policy", value: "camera=(), geolocation=(self), payment=()" },
];

// Checkout is the one place that needs the payment permission, and it needs to
// delegate it to Stripe's iframe as well as allow it here. Without this,
// Apple Pay and Google Pay fail with "Permissions policy violation: payment is
// not allowed in this document" — the card form still works, so the loss is
// silent, and it costs the wallet conversions that matter most on a phone.
//
// Scoped to /checkout rather than relaxed globally: no other route should be
// able to invoke a payment sheet.
const checkoutHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: 'camera=(), geolocation=(self), payment=(self "https://js.stripe.com")',
  },
];

const nextConfig: NextConfig = {
  generateBuildId: async () => {
    return `build-${Date.now()}`
  },
  async headers() {
    return [
      {
        // Checkout first: Next applies the first matching rule per header, so
        // this must precede the catch-all or the payment permission is lost.
        // Query strings do not affect path matching, so this covers
        // /checkout?plan=crew as well.
        source: "/checkout",
        headers: checkoutHeaders,
      },
      {
        source: "/checkout/:path*",
        headers: checkoutHeaders,
      },
      {
        // every route except /q/** (embeddable widget) and /checkout
        source: "/((?!q/|checkout).*)",
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
