import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Axis Performance — AI Blueprint & Permit Platform',
  description: 'Upload blueprints, get instant room detection, material lists, cost estimates, compliance checks, and automated permit filing.',
  keywords: ['blueprint analysis', 'permit filing', 'construction estimating', 'AI', 'material takeoff'],
  authors: [{ name: 'Axis Performance' }],
  openGraph: {
    title: 'Axis Performance — AI Blueprint & Permit Platform',
    description: 'Analyze blueprints in minutes. File permits automatically.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          window.onerror = function(msg, src, line, col, err) {
            var d = document.createElement('div');
            d.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#fff;z-index:999999;padding:32px;overflow:auto;font-family:monospace;font-size:13px';
            var stack = (err && err.stack) ? err.stack : (msg + '\\n\\nAt: ' + src + ':' + line + ':' + col);
            d.innerHTML = '<div style="max-width:800px;margin:0 auto"><h2 style="color:#dc2626;font-size:18px;font-weight:700;margin-bottom:8px">JavaScript Error — Copy and send to support</h2><p style="color:#64748b;margin-bottom:16px;font-size:13px">This is the exact error causing the crash:</p><pre id="__err_text" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;white-space:pre-wrap;word-break:break-all;color:#b91c1c;max-height:60vh;overflow:auto">' + stack.replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</pre><button onclick="var t=document.getElementById(\'__err_text\');navigator.clipboard.writeText(t.innerText);this.innerText=\'Copied!\'" style="margin-top:16px;padding:10px 24px;background:#2563eb;color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">Copy Error</button></div>';
            document.body ? document.body.appendChild(d) : document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(d); });
          };
          window.addEventListener('unhandledrejection', function(e) {
            var err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
            window.onerror(err.message, '', 0, 0, err);
          });
        `}} />
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  )
}
