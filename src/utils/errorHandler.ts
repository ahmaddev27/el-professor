/**
 * Turns a Supabase/PostgREST error into the sentence a screen shows.
 *
 * `handleDatabaseError` keeps its signature and its German text, so every
 * existing caller is unchanged. `describeDatabaseError` returns the same
 * sentence with the dictionary key beside it, for a screen that renders
 * `engineText(t, …)`.
 *
 * The database's own `error.message` has no key: it is not our text.
 */
// Type-only: this module names a dictionary key beside its German text.
import type { EngineMessageKey } from '../i18n/engineMessageTypes';

export interface DatabaseErrorMessage {
  /** German, as this module has always written it. The screens' fallback. */
  text: string;
  /** Absent when the text is the database's own message rather than ours. */
  messageKey?: EngineMessageKey;
}

export const describeDatabaseError = (error: any): DatabaseErrorMessage => {
  if (!error) {
    return { text: 'Ein unerwarteter Fehler ist aufgetreten', messageKey: 'engine.dbError.unexpected' };
  }

  const errorMessage = error.message || '';
  const errorCode = error.code || '';

  if (errorCode === '42501' || errorMessage.includes('permission denied') || errorMessage.includes('policy')) {
    return { text: 'Keine Berechtigung: Nur Admin oder Ersteller', messageKey: 'engine.dbError.notAuthorized' };
  }

  if (errorCode === '23503' || errorMessage.includes('foreign key')) {
    return { text: 'Dieser Eintrag kann nicht gelöscht werden, da er noch verwendet wird', messageKey: 'engine.dbError.stillReferenced' };
  }

  if (errorCode === '23505' || errorMessage.includes('unique')) {
    return { text: 'Ein Eintrag mit diesen Daten existiert bereits', messageKey: 'engine.dbError.duplicate' };
  }

  if (errorMessage.includes('not found')) {
    return { text: 'Der angeforderte Eintrag wurde nicht gefunden', messageKey: 'engine.dbError.notFound' };
  }

  if (errorMessage) {
    // The database's own wording — not ours to translate.
    return { text: errorMessage };
  }

  return { text: 'Ein Datenbankfehler ist aufgetreten', messageKey: 'engine.dbError.generic' };
};

export const handleDatabaseError = (error: any): string => describeDatabaseError(error).text;
