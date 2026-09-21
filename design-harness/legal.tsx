import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../src/contexts/LanguageContext';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import { LegalPageView, type LegalPageState } from '../src/pages/LegalPage';
import { IMPRESSUM_FIELDS, NO_PRIVACY_TEXT, type Impressum, type LegalPageKind } from '../src/lib/legalPages';
import '../src/index.css';
import { applyStoredPreferences } from './scenario';

/**
 * `/impressum` and `/datenschutz` as drawn, on invented data, for the
 * screenshots in Docs/design/legal-pages/ (capture-legal.mjs).
 *
 * The production `LegalPageView` renders here unchanged; only its state is
 * supplied instead of loaded, because the page's one call is
 * `get_legal_pages()` and this harness has no database. Every fact below is
 * invented and obviously so — Muster, Musterstadt, example.com — and lives in
 * this file alone: the application never shows a fact the owner did not enter.
 *
 *   /design-harness/legal.html?page=impressum|datenschutz&data=filled|empty|error|loading&theme=light|dark&lang=de|en
 */

applyStoredPreferences();

const params = new URLSearchParams(window.location.search);
const page: LegalPageKind = params.get('page') === 'datenschutz' ? 'privacy' : 'impressum';
const data = params.get('data') ?? 'filled';

const EMPTY_IMPRESSUM = Object.fromEntries(IMPRESSUM_FIELDS.map(field => [field, ''])) as Impressum;

const INVENTED_IMPRESSUM: Impressum = {
  legal_name: 'Musterfirma Mobility GmbH',
  legal_form: 'Gesellschaft mit beschränkter Haftung',
  street: 'Musterstraße',
  house_number: '1',
  postal_code: '12345',
  city: 'Musterstadt',
  represented_by: 'Erika Mustermann (Geschäftsführerin)',
  contact_email: 'kontakt@example.com',
  contact_phone: '+49 (0)123 456789-0',
  register_court: 'Amtsgericht Musterstadt',
  register_number: 'HRB 00000',
  vat_id: 'DE000000000',
  content_responsible_name: 'Erika Mustermann',
  content_responsible_address: 'Musterstraße 1, 12345 Musterstadt',
};

const INVENTED_PRIVACY = {
  asOf: '2026-09-21',
  paragraphs: [
    'Beispieltext für die Vorschau. Hier steht später der Text, den der Anwalt des Betreibers liefert.',
    'Verantwortlicher:\nMusterfirma Mobility GmbH\nMusterstraße 1\n12345 Musterstadt',
    'Jeder Absatz erscheint so, wie er eingetragen wurde. Ein einfacher Zeilenumbruch innerhalb eines Absatzes bleibt erhalten, eine Leerzeile trennt zwei Absätze. Auszeichnung in HTML gibt es nicht: gespeichert wird reiner Text.',
    'Ein längerer Absatz zeigt, wie der Text auf einem schmalen Bildschirm umbricht, ohne dass die Seite seitlich scrollt: '
      + 'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore et dolore magna aliquyam erat, sed diam voluptua.',
  ],
};

const state: LegalPageState =
  data === 'loading' ? { status: 'loading' }
  : data === 'error' ? { status: 'failed' }
  : data === 'empty' ? { status: 'ready', pages: { impressum: EMPTY_IMPRESSUM, privacy: NO_PRIVACY_TEXT } }
  : { status: 'ready', pages: { impressum: INVENTED_IMPRESSUM, privacy: INVENTED_PRIVACY } };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <ThemeProvider>
        <LegalPageView page={page} state={state} onRetry={() => undefined} />
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>,
);
