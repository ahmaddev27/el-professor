export const handleDatabaseError = (error: any): string => {
  if (!error) return 'Ein unerwarteter Fehler ist aufgetreten';

  const errorMessage = error.message || '';
  const errorCode = error.code || '';

  if (errorCode === '42501' || errorMessage.includes('permission denied') || errorMessage.includes('policy')) {
    return 'Keine Berechtigung: Nur Admin oder Ersteller';
  }

  if (errorCode === '23503' || errorMessage.includes('foreign key')) {
    return 'Dieser Eintrag kann nicht gelöscht werden, da er noch verwendet wird';
  }

  if (errorCode === '23505' || errorMessage.includes('unique')) {
    return 'Ein Eintrag mit diesen Daten existiert bereits';
  }

  if (errorMessage.includes('not found')) {
    return 'Der angeforderte Eintrag wurde nicht gefunden';
  }

  if (errorMessage) {
    return errorMessage;
  }

  return 'Ein Datenbankfehler ist aufgetreten';
};
