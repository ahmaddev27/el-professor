import React, { useEffect, useState } from 'react';
import SalariesManagement from '../components/SalariesManagement';
import { Driver } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { handleDatabaseError } from '../utils/errorHandler';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';

const SalariesPage: React.FC = () => {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { error: showError } = useToast();
  const { companyId } = useAuth();

  useEffect(() => {
    if (companyId) loadDrivers();
  }, [companyId]);

  const loadDrivers = async () => {
    try {
      setLoading(true);
      setLoadError(false);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), 10000)
      );

      const dataPromise = supabase
        .from('drivers')
        .select('*')
        .eq('company_id', companyId)
        .order('name', { ascending: true });

      const { data, error } = await Promise.race([dataPromise, timeoutPromise]) as any;

      if (error) throw error;
      setDrivers(data || []);
    } catch (err: any) {
      console.error('Error loading drivers:', err);
      setLoadError(true);
      showError('Fehler beim Laden', handleDatabaseError(err));
      setDrivers([]);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Lade Fahrerdaten...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <div className="text-center">
          <p className="text-lg font-semibold mb-2" style={{ color: 'var(--danger)' }}>Fehler beim Laden der Daten</p>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>Die Verbindung zur Datenbank konnte nicht hergestellt werden.</p>
        </div>
        <button
          onClick={loadDrivers}
          className="px-6 py-2 rounded-lg transition-colors"
          style={{ background: 'var(--accent)', color: 'white' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--accent-hover)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--accent)'; }}
        >
          Erneut versuchen
        </button>
      </div>
    );
  }

  return <SalariesManagement drivers={drivers} />;
};

export default SalariesPage;
