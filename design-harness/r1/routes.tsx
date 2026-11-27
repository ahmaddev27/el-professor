import { useEffect } from 'react';
import { Route } from 'react-router-dom';
import LockedFeaturePage from '../../src/components/LockedFeaturePage';
import { supabase } from '../../src/lib/supabase';
import { r1Screen } from './fixtures';

/**
 * The locked page issues no query, and `settle()` in capture.mjs waits for the
 * first answered one. One harmless read stands in for it; it changes nothing on
 * screen and is harness-only.
 */
function WithOneRead({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // A query builder runs only when something calls `then` on it.
    void supabase.from('cars').select('id').then(() => undefined);
  }, []);
  return <>{children}</>;
}

/** The Übersicht is the applayout batch's existing `/overview` route; only the locked pages are new. */
export const R1_ROUTES = (
  <>
    <Route
      path="r1/gesperrt"
      element={<WithOneRead><LockedFeaturePage featureName="Werkstatt" requiredPlan="advanced" /></WithOneRead>}
    />
    <Route
      path="r1/gesperrt-premium"
      element={<WithOneRead><LockedFeaturePage featureName="Gehälter" requiredPlan="premium" /></WithOneRead>}
    />
  </>
);

const ENTRY: Record<string, string> = {
  'r1-uebersicht': '/overview',
  'r1-uebersicht-leer': '/overview',
  'r1-gesperrt': '/r1/gesperrt',
  'r1-gesperrt-premium': '/r1/gesperrt-premium',
};

/** Where the memory router starts on this batch's screens, or undefined on another's. */
export function r1InitialEntry(): string | undefined {
  return r1Screen ? ENTRY[r1Screen] : undefined;
}
