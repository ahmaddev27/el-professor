import React from 'react';
import BackupManagement from '../components/BackupManagement';

/**
 * Datensicherung, at `/datensicherung`.
 *
 * It used to be a tab on Benutzer, which is gated on `rollen_nutzer` —
 * `advanced` in the plan feature map. The Basic plan is nevertheless sold with a
 * backup (`LandingPage.tsx:543` lists `landing.plan.feature.backup` on it), so a
 * Basic administrator paid for a feature no route let them reach. A page of its
 * own, registered like `/billing` and `/settings` — administrator-only and not
 * plan-gated — is the shape this repo already uses for "every plan, admins
 * only", and it needs no new `FeatureKey`. See the route in App.tsx for why a
 * key would have been the wrong instrument.
 *
 * BackupManagement draws its own header inside its Card, as RolesManagement does
 * for `/roles`, so the page adds no second one. AppLayout already pads it.
 */
const BackupPage: React.FC = () => {
  return <BackupManagement />;
};

export default BackupPage;
