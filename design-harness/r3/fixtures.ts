/**
 * Design remake, batch R3: Mein Konto (/mein-konto). The screens are named
 * through `?screen=`: `r3-konto` (a company user) and `r3-konto-plattform` (a
 * platform account, whose e-mail change asks for a password and no code).
 * The page itself reads one table, `companies` (the company name).
 * GoTrue's settings and the passkey list are raw `fetch` calls; routes.tsx
 * answers them for these two screens only. Nothing here is a real person.
 */
const requested = new URLSearchParams(window.location.search).get('screen') ?? '';
export const r3Screen: string | null = requested.startsWith('r3-') ? requested : null;
export const r3IsPlatform = requested === 'r3-konto-plattform';

export const R3_PASSKEYS = [
  { id: 'r3-pk-1', friendly_name: 'MacBook Touch ID', created_at: '2026-08-02T09:14:00Z', last_used_at: '2026-09-12T07:40:00Z' },
  { id: 'r3-pk-2', friendly_name: 'Pixel 9', created_at: '2026-09-01T16:02:00Z', last_used_at: null },
];
