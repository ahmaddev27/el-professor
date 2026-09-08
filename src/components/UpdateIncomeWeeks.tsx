import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import ConfirmationModal from './ConfirmationModal';

const UpdateIncomeWeeks: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const { success, error: showError } = useToast();

  const handleUpdate = () => {
    setShowConfirm(true);
  };

  const doUpdate = async () => {
    setShowConfirm(false);
    try {
      setLoading(true);
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

      const response = await fetch(
        `${supabaseUrl}/functions/v1/update-income-weeks`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const result = await response.json();

      if (result.success) {
        success(
          'Aktualisierung erfolgreich',
          `${result.updated} Einnahmen wurden aktualisiert`
        );
      } else {
        showError('Fehler', result.error || 'Ein Fehler ist aufgetreten');
      }
    } catch (err: any) {
      console.error('Error updating income weeks:', err);
      showError('Fehler', err.message || 'Fehler beim Aktualisieren der Einnahmen');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={handleUpdate}
        disabled={loading}
        className={`px-4 py-2 rounded-lg transition-colors flex items-center gap-2 ${
          loading
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : 'bg-blue-600 text-white hover:bg-blue-700'
        }`}
      >
        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        {loading ? 'Aktualisiere...' : 'Alle Wochennummern aktualisieren'}
      </button>
      <ConfirmationModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={doUpdate}
        title="Wochennummern aktualisieren"
        message="Möchten Sie alle Einnahmen mit Wochennummern aktualisieren? Dies überschreibt die Beschreibungen mit den korrekten Wochennummern."
        type="confirm"
        confirmText="Aktualisieren"
        cancelText="Abbrechen"
      />
    </>
  );
};

export default UpdateIncomeWeeks;
