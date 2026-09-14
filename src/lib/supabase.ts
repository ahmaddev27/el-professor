import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * What brought the browser to this page, read before the client below parses
 * the URL. With detectSessionInUrl, supabase-js creates the session from a
 * reset or invite link and then strips the hash — so by the time
 * AuthCallbackPage mounts, "type=recovery" is gone, and a password reset
 * landed on the dashboard instead of the password form.
 */
export const authRedirect: { type: string; error: string } = (() => {
  if (typeof window === 'undefined') return { type: '', error: '' };
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const read = (key: string) => hash.get(key) ?? query.get(key) ?? '';
  return { type: read('type'), error: read('error_description') || read('error') };
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