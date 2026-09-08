import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useDatabase } from '../hooks/useDatabase';
import { Driver } from '../types/receipt';
import DriversManagement from '../components/DriversManagement';
import { DriverPlanningFields } from '../components/DriverModal';
import { handleDatabaseError } from '../utils/errorHandler';

const FahrerPage: React.FC = () => {
  const { user, canEdit, canDelete, canCreate } = useAuth();
  const { success, error: showError } = useToast();
  const { drivers: driverActions, isLoading: dbLoading } = useDatabase();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);

  const canEditDriver = (driver: Driver): boolean => {
    return canEdit(driver.createdBy);
  };

  const canDeleteDriver = (driver: Driver): boolean => {
    return canDelete(driver.createdBy);
  };

  useEffect(() => {
    if (!dbLoading) {
      loadData();
    }
  }, [dbLoading]);

  const loadData = async () => {
    setLoading(true);
    try {
      const driversData = await driverActions.get();
      setDrivers(driversData);
    } catch (error) {
      console.error('Error loading drivers:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddDriver = async (name: string, salaryRatio: number, personalnummer: string, gender: 'male' | 'female' | null, planning?: DriverPlanningFields) => {
    if (!canCreate) {
      showError('Keine Berechtigung', 'Nur Administratoren und Ersteller können Fahrer hinzufügen');
      return;
    }

    try {
      await driverActions.add(name, salaryRatio, personalnummer, gender, planning);
      await loadData();
      success('Fahrer erstellt', 'Der Fahrer wurde erfolgreich hinzugefügt');
    } catch (err) {
      console.error('Error adding driver:', err);
      showError('Fehler beim Erstellen', handleDatabaseError(err));
    }
  };

  const handleUpdateDriver = async (id: string, name: string, salaryRatio: number, status?: 'active' | 'inactive', personalnummer?: string, gender?: 'male' | 'female' | null, planning?: DriverPlanningFields) => {
    try {
      await driverActions.update(id, name, salaryRatio, status, personalnummer, gender, planning);
      await loadData();
      success('Fahrer aktualisiert', 'Der Fahrer wurde erfolgreich geändert');
    } catch (err) {
      console.error('Error updating driver:', err);
      showError('Fehler beim Aktualisieren', handleDatabaseError(err));
    }
  };

  const handleDeleteDriver = async (id: string) => {
    try {
      await driverActions.delete(id);
      await loadData();
      success('Fahrer gelöscht', 'Der Fahrer wurde erfolgreich entfernt');
    } catch (err) {
      console.error('Error deleting driver:', err);
      showError('Fehler beim Löschen', handleDatabaseError(err));
    }
  };

  if (loading || dbLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Fahrer</h2>
      <DriversManagement
        drivers={drivers}
        onAddDriver={handleAddDriver}
        onEditDriver={handleUpdateDriver}
        onDeleteDriver={handleDeleteDriver}
        canEdit={canEditDriver}
        canDelete={canDeleteDriver}
      />
    </div>
  );
};

export default FahrerPage;
