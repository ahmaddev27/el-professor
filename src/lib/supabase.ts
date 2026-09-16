import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * What brought the browser to this page, read before the client below parses
 * the URL. With detectSessionInUrl, supabase-js creates the session from a
 * reset or invite link and then strips the hash — so by the time
 * AuthCallbackPage mounts, "type=recovery" is gone, and a password reset
 * landed on the dashboard instead of the password form.
 *
 * A failed Google sign-in comes back the same way and needs all three error
 * parameters (plan 1.6): GoTrue redirects with `error` (the OAuth2 family),
 * `error_code` (its own code, which is what the screens map to a sentence) and
 * `error_description` (English prose written for a developer, never shown).
 *
 * `error` keeps its original meaning — the description if there is one, else
 * the family — because that is what the mail-link screens have always read.
 */
export const authRedirect: { type: string; error: string; errorFamily: string; errorCode: string } = (() => {
  if (typeof window === 'undefined') return { type: '', error: '', errorFamily: '', errorCode: '' };
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const read = (key: string) => hash.get(key) ?? query.get(key) ?? '';
  return {
    type: read('type'),
    error: read('error_description') || read('error'),
    errorFamily: read('error'),
    errorCode: read('error_code'),
  };
})();

/**
 * Returns the canonical app origin used for auth email redirect URLs.
 *
 * Priority:
 *  1. VITE_APP_URL env var — set this in production to your real domain.
 *  2. window.location.origin — correct for local dev.
 *
 * This value is appended with /auth/callback to produce the full redirectTo URL
 * that lands in Supabase password-reset and invite emails.
 */
export const appOrigin: string =
  (import.meta.env.VITE_APP_URL as string | undefined)?.replace(/\/$/, '') ||
  window.location.origin;

console.log('🔧 Supabase Configuration Check:');
console.log('📍 URL:', supabaseUrl ? 'SET' : 'NOT SET');
console.log('🔑 Anon Key:', supabaseAnonKey ? 'SET' : 'NOT SET');

export const isSupabaseConfigured = !!(supabaseUrl && supabaseAnonKey);
console.log('✅ Supabase Configured:', isSupabaseConfigured);

const defaultUrl = 'https://placeholder.supabase.co';
const defaultKey = 'placeholder-key';

export const supabase = createClient(
  supabaseUrl || defaultUrl,
  supabaseAnonKey || defaultKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'receipt-app-auth',
    }
  }
);

console.log('🚀 Supabase client created');


// Database types
export interface Database {
  public: {
    Tables: {
      drivers: {
        Row: {
          id: string;
          name: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          created_at?: string;
        };
      };
      receipts: {
        Row: {
          id: string;
          receipt_number: string;
          date: string;
          description: string;
          driver_name: string;
          income: number;
          expense: number;
          balance: number;
          postal_code: string | null;
          city: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          receipt_number: string;
          date: string;
          description: string;
          driver_name: string;
          income?: number;
          expense?: number;
          balance?: number;
          postal_code?: string | null;
          city?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          receipt_number?: string;
          date?: string;
          description?: string;
          driver_name?: string;
          income?: number;
          expense?: number;
          balance?: number;
          postal_code?: string | null;
          city?: string | null;
          created_at?: string;
        };
      };
    };
  };
}