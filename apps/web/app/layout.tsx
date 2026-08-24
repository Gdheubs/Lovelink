import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '../lib/AuthProvider';
import { SignallingProvider } from '../lib/SignallingProvider';
import { PwaProvider } from '../lib/PwaProvider';
import { BottomNav } from '../lib/BottomNav';
import './globals.css';

/**
 * The app shell.
 *
 * `AuthProvider` wraps everything because the very first thing the app must do
 * — before any page decides what to render — is find out whether there is a
 * session, by trying the httpOnly refresh cookie. Doing that per-page would
 * mean each one independently flashes a sign-in screen on load.
 */
export const metadata: Metadata = {
  title: 'Loverlink',
  description: 'Drop into a room. Listen first. Talk when you are ready.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Loverlink',
  },
  // This is a private social space, not a content site. Keeping it out of
  // search results is a safety property, not an SEO oversight.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#100a18',
  width: 'device-width',
  initialScale: 1,
  // `viewportFit: cover` is what lets the CSS use env(safe-area-inset-*) to
  // avoid the notch and the home indicator when installed as a PWA.
  viewportFit: 'cover',
  // Zoom is NOT disabled. Blocking it is a common PWA reflex and an
  // accessibility failure for anyone who needs to magnify text.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          {/*
            Inside AuthProvider because it needs a session before it can open a
            socket, and wrapping everything because a ringing phone has to
            reach the user on whatever screen they happen to be on. See
            SignallingProvider for why this cannot live on a page.
          */}
          <PwaProvider>
            <SignallingProvider>
              {children}
              <BottomNav />
            </SignallingProvider>
          </PwaProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
