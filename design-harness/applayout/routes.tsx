import { Route } from 'react-router-dom';
import OverviewPage from '../../src/pages/OverviewPage';
import NotificationsPage from '../../src/pages/NotificationsPage';
import WerkstattPage from '../../src/pages/WerkstattPage';
import { applayoutScreen } from './fixtures';

/**
 * The three screens phase 5 never converted, so the frame can be judged around
 * a legacy page as well as around a converted one.
 */
export const APPLAYOUT_ROUTES = (
  <>
    <Route path="overview" element={<OverviewPage />} />
    <Route path="benachrichtigungen" element={<NotificationsPage />} />
    <Route path="werkstatt" element={<WerkstattPage />} />
  </>
);

const ENTRY: Record<string, string> = {
  uebersicht: '/overview',
  benachrichtigungen: '/benachrichtigungen',
  werkstatt: '/werkstatt',
};

/** Where the memory router starts on this batch's screens, or undefined on another's. */
export function applayoutInitialEntry(): string | undefined {
  return applayoutScreen ? ENTRY[applayoutScreen] : undefined;
}
