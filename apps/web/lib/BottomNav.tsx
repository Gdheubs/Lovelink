'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The five-tab shell.
 *
 * WHY IT IS HIDDEN INSIDE A ROOM
 * ------------------------------
 * A room is the one place in this product where the person is doing something
 * rather than choosing something. Leaving a tab bar there does two bad things:
 * it invites a tap that drops someone out of a live conversation, and it says
 * the room is a page among pages rather than somewhere you are.
 *
 * The room has its own way out, and it is deliberately the only one.
 *
 * WHY THERE ARE NO BADGES
 * -----------------------
 * No unread counts, no red dots, nothing that grows. A badge is a small debt
 * the app keeps reminding you of, and this product's whole claim is that it
 * does not do that. Something waiting for you appears where it belongs — on
 * Connections, when you get there.
 */

const TABS = [
  { href: '/home', label: 'Home', glyph: '⌂' },
  { href: '/rooms', label: 'Rooms', glyph: '◍' },
  { href: '/connections', label: 'People', glyph: '⁂' },
  { href: '/surprises', label: 'Surprises', glyph: '✦' },
  { href: '/profile', label: 'You', glyph: '◐' },
] as const;

/**
 * Where the shell does NOT appear.
 *
 * Everything before someone is signed in, and inside a room. A prefix match, so
 * `/rooms/<id>` is hidden while `/rooms` itself is not — which is exactly the
 * distinction between browsing rooms and being in one.
 */
function shouldHide(pathname: string): boolean {
  if (pathname === '/' || pathname.startsWith('/signin')) return true;
  return /^\/rooms\/[^/]+/.test(pathname);
}

export function BottomNav() {
  const pathname = usePathname() ?? '/';

  if (shouldHide(pathname)) return null;

  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((tab) => {
        // `/rooms` should not light up while you are on `/rooms/<id>`, because
        // by then the tab bar is gone anyway — but the same rule keeps
        // `/connections` lit on a nested screen, which is right.
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={active ? 'tab tab--on' : 'tab'}
            aria-current={active ? 'page' : undefined}
          >
            <span className="tab__glyph" aria-hidden="true">
              {tab.glyph}
            </span>
            <span className="tab__label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
