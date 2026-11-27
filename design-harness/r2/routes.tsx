import { Route } from 'react-router-dom';
import { NotesPage } from '../../src/pages/NotesPage';
import { r2Screen } from './fixtures';

/**
 * No earlier batch registers Notizen. `/werkstatt` and `/benachrichtigungen`
 * are the applayout batch's routes and are reused. All three screens issue
 * their own reads, so settle() needs no stand-in query.
 */
export const R2_ROUTES = <Route path="notes" element={<NotesPage />} />;

const ENTRY: Record<string, string> = {
  'r2-notizen': '/notes',
  'r2-notizen-leer': '/notes',
  'r2-werkstatt': '/werkstatt',
  'r2-werkstatt-leer': '/werkstatt',
  'r2-benachrichtigungen': '/benachrichtigungen',
};

/** Where the memory router starts on this batch's screens, or undefined on another's. */
export function r2InitialEntry(): string | undefined {
  return r2Screen ? ENTRY[r2Screen] : undefined;
}
