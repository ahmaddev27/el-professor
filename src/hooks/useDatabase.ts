import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Receipt, Driver, DriverContact } from '../types/receipt';
import { DEFAULT_DRIVER_LANGUAGE } from '../lib/driverLanguage';
import { isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { withTimeout } from './useTimeout';
import { DriverPlanningFields } from '../components/DriverModal';
import { mapDriverRow } from '../lib/driverRow';
import { numberOrUndefined } from '../utils/receiptDisplay';
import { assertRowsUpdated } from '../utils/updateOutcome';

export const useDatabase = () => {
  const { user, profile } = useAuth();
  const { t } = useTranslation();
  /*
    The company the session is in (plan 3.4b), not the account's membership.

    This hook is the data layer of Belege and Fahrer, and of the receipt and
    driver halves of the Overview and Umsätze. It filtered by
    `AuthContext.companyId`, which is null for a platform account, so those
    screens asked for `company_id = null` inside a support session: an empty
    list with no error, which is exactly what the owner reported.
  */
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string[]>([]);

  const addDebugInfo = (message: string) => {
    console.log(message);
    setDebugInfo(prev => [...prev.slice(-10), `${new Date().toLocaleTimeString()}: ${message}`]);
  };

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    setIsLoading(true);
    setError(null);
    addDebugInfo('🔍 Starting connection check...');
    
    try {
      // Check if environment variables are available
      if (!isSupabaseConfigured) {
        addDebugInfo('❌ Supabase environment variables not found');
        addDebugInfo(`VITE_SUPABASE_URL: ${import.meta.env.VITE_SUPABASE_URL ? 'SET' : 'NOT SET'}`);
        addDebugInfo(`VITE_SUPABASE_ANON_KEY: ${import.meta.env.VITE_SUPABASE_ANON_KEY ? 'SET' : 'NOT SET'}`);
        setError(t('db.notConfigured'));
        setIsConnected(false); // Force localStorage mode
        setIsLoading(false);
        return;
      }

      addDebugInfo('✅ Environment variables found, testing connection...');
      addDebugInfo(`🔗 Supabase URL: ${import.meta.env.VITE_SUPABASE_URL}`);
      addDebugInfo(`🔑 Anon Key: ${import.meta.env.VITE_SUPABASE_ANON_KEY ? 'Present' : 'Missing'}`);
      
      // Test the connection with a simple query to receipts table
      addDebugInfo('🧪 Testing connection to receipts table...');
      addDebugInfo(`🔓 Using authenticated access: ${user ? 'Authenticated' : 'Anonymous'}`);
      const { data, error } = await withTimeout(
        supabase
          .from('receipts')
          .select('id')
          .limit(1),
        5000
      );
        
      if (error) {
        addDebugInfo(`❌ Connection test failed: ${error.message}`);
        addDebugInfo(`❌ Error details: ${JSON.stringify(error)}`);
        addDebugInfo(`❌ Error code: ${error.code}`);
        addDebugInfo(`❌ Error hint: ${error.hint}`);
        throw error;
      }
      
      addDebugInfo(`✅ Connection test successful, sample data: ${JSON.stringify(data)}`);
      setIsConnected(true);
      addDebugInfo('✅ Database connected successfully');
    } catch (error) {
      addDebugInfo(`❌ Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      addDebugInfo(`❌ Full error: ${JSON.stringify(error)}`);
      setError(error instanceof Error ? error.message : 'Connection failed');
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * A write attempted while the hook is not connected reaches nothing, so it
   * must fail rather than resolve.
   *
   * The read branches below fall back to `localStorage`, which CLAUDE.md records
   * as a legacy quirk of this hook. The *write* half of that fallback was never
   * built: every use of it in this file is a `getItem`. Six write branches
   * nevertheless resolved — `updateDriver`, `updateReceipt` and
   * `deleteReceipt` with a bare `return` (a sixth, the driver delete, is gone since 21.10.2026), and `addDriver` and `addReceipt` by
   * handing the caller a fabricated row with a `Date.now()` id. Every one of the
   * six call sites then showed its success toast and reloaded a list that could
   * not contain the row.
   *
   * This does not build the missing fallback — CLAUDE.md is explicit that this
   * hook is not a pattern to extend. It makes the discarded write say so. Each
   * caller already wraps the call in `try`/`catch` and renders
   * `handleDatabaseError(err)`, which passes an `Error`'s own message through,
   * so the sentence below is what the screen shows.
   */
  const refuseOfflineWrite = (): never => {
    throw new Error(t('db.offlineWrite'));
  };

  // Driver operations
  const getDrivers = async (): Promise<Driver[]> => {
    if (!isConnected) {
      addDebugInfo('📱 Loading drivers from localStorage (not connected)');
      const saved = localStorage.getItem('drivers');
      const result = saved ? JSON.parse(saved) : [];
      addDebugInfo(`📱 LocalStorage drivers: ${result.length} found`);
      return result;
    }

    try {
      addDebugInfo('🗄️ Loading drivers from database...');
      const { data, error } = await withTimeout(
        supabase
          .from('drivers')
          .select('*')
          .eq('company_id', companyId)
          .order('name'),
        8000
      );
      
      if (error) {
        addDebugInfo(`❌ Error fetching drivers: ${error.message}`);
        throw error;
      }
      
      addDebugInfo(`👥 Database drivers raw data: ${JSON.stringify(data)}`);
      
      if (!data || data.length === 0) {
        addDebugInfo('📝 No drivers found in database');
        return [];
      }
      
      const mappedDrivers = data.map(mapDriverRow);
      
      addDebugInfo(`✅ Mapped drivers: ${mappedDrivers.length} drivers`);
      return mappedDrivers;
    } catch (error) {
      console.error('❌ Failed to get drivers from database:', error);
      addDebugInfo(`❌ Failed to get drivers from database: ${error instanceof Error ? error.message : 'Unknown error'}`);
      addDebugInfo('📱 Falling back to localStorage for drivers');
      const saved = localStorage.getItem('drivers');
      return saved ? JSON.parse(saved) : [];
    }
  };

  const planningToDb = (p?: DriverPlanningFields) => {
    if (!p) return {};
    return {
      employment_type:        p.employment_type ?? 'employee',
      driver_usage_type:      p.driver_usage_type,
      // `target_monthly_hours` and `max_monthly_hours` are not written any more:
      // the plan works from salaries (owner's decision, 01.10.2026) and nothing
      // reads either column. They are left untouched rather than nulled on every
      // save, so no driver's stored history is rewritten by an unrelated edit;
      // dropping the columns is a migration of its own.
      planning_target_salary: p.planning_target_salary !== '' ? parseFloat(p.planning_target_salary) : null,
      planning_min_salary:    p.planning_min_salary !== '' ? parseFloat(p.planning_min_salary) : null,
      planning_max_salary:    p.planning_max_salary !== '' ? parseFloat(p.planning_max_salary) : null,
      planning_hourly_rate:   p.planning_hourly_rate !== '' ? parseFloat(p.planning_hourly_rate) : null,
      planning_priority:      parseInt(p.planning_priority) || 100,
      planning_enabled:       p.planning_enabled,
      can_cover_other_drivers: p.can_cover_other_drivers,
      work_window_start:      p.work_window_start && p.work_window_start.trim() !== '' ? p.work_window_start.trim() : null,
      work_window_end:        p.work_window_end && p.work_window_end.trim() !== '' ? p.work_window_end.trim() : null,
      allowed_weekdays:       Array.isArray(p.allowed_weekdays) && p.allowed_weekdays.length > 0 ? p.allowed_weekdays : null,
      allow_outside_shift_exceptions: !!p.allow_outside_shift_exceptions,
      is_full_day_available:  !!p.is_full_day_available,
    };
  };

  const addDriver = async (name: string, salaryRatio: number = 0.5, personalnummer?: string, gender?: 'male' | 'female' | null, planning?: DriverPlanningFields, contact?: DriverContact): Promise<Driver> => {
    if (!isConnected) {
      refuseOfflineWrite();
    }

    try {
      addDebugInfo('🗄️ Adding driver to database');
      addDebugInfo('🔓 Using authenticated access for driver insert');
      const { data, error } = await supabase
        .from('drivers')
        .insert({
          name,
          salary_ratio: salaryRatio,
          personalnummer: personalnummer || null,
          gender: gender ?? null,
          // Both already normalised by the form: the address trimmed, the number
          // in E.164. Written as null when absent, which is what the send path
          // reads to mean "skip this driver and name them".
          email: contact?.email ?? null,
          phone: contact?.phone ?? null,
          // Absent means the owner's default; the column also defaults to it.
          preferred_language: contact?.preferred_language ?? DEFAULT_DRIVER_LANGUAGE,
          user_id: user?.id || null,
          created_by: user?.id || null,
          company_id: companyId,
          ...planningToDb(planning),
        })
        .select()
        .single();

      if (error) {
        console.error('Error adding driver:', error);
        addDebugInfo(`❌ Error adding driver: ${error.message}`);
        addDebugInfo(`❌ Error code: ${error.code}`);
        addDebugInfo(`❌ Error hint: ${error.hint}`);
        throw error;
      }

      return { id: data.id, name: data.name, salary_ratio: data.salary_ratio, personalnummer: data.personalnummer || undefined, gender: (data.gender ?? null) as 'male' | 'female' | null, employment_type: (data.employment_type ?? 'employee') as 'employee' | 'company_owner' };
    } catch (error) {
      console.error('Failed to add driver to database:', error);
      throw error;
    }
  };

  const updateDriver = async (id: string, name: string, salaryRatio: number = 0.5, status?: 'active' | 'inactive', personalnummer?: string, gender?: 'male' | 'female' | null, planning?: DriverPlanningFields, contact?: DriverContact): Promise<void> => {
    if (!isConnected) {
      refuseOfflineWrite();
    }

    try {
      const updateData: any = { name, salary_ratio: salaryRatio };
      if (status !== undefined) {
        updateData.status = status;
      }
      if (personalnummer !== undefined) {
        updateData.personalnummer = personalnummer || null;
      }
      if (gender !== undefined) {
        updateData.gender = gender;
      }
      if (planning !== undefined) {
        Object.assign(updateData, planningToDb(planning));
      }
      // Conditional like every field above it, and that is what keeps the status
      // toggle from clearing an address: `handleToggleStatus` calls this with four
      // arguments, so `contact` is undefined and neither column is named at all.
      if (contact !== undefined) {
        updateData.email = contact.email;
        updateData.phone = contact.phone;
        updateData.preferred_language = contact.preferred_language;
      }

      const { data, error } = await supabase
        .from('drivers')
        .update(updateData)
        .eq('id', id)
        .select('id');

      if (error) {
        console.error('Error updating driver:', error);
        throw error;
      }
      // Deactivating a driver is this UPDATE, and a policy that refuses it
      // answers 200 with no row: without this the screen toasted success.
      assertRowsUpdated(data, t('fahrer.updateRefused'));
    } catch (error) {
      console.error('Failed to update driver in database:', error);
      throw error;
    }
  };

  // Receipt operations
  const getReceipts = async (): Promise<Receipt[]> => {
    if (!isConnected) {
      addDebugInfo('📱 Loading receipts from localStorage (not connected)');
      const saved = localStorage.getItem('receipts');
      let result = [];
      try {
        result = saved ? JSON.parse(saved) : [];
      } catch (error) {
        addDebugInfo('❌ Error parsing receipts from localStorage');
        result = [];
      }
      addDebugInfo(`📱 LocalStorage receipts: ${result.length} found`);
      return result;
    }

    try {
      addDebugInfo('🗄️ Loading receipts from database...');
      addDebugInfo('🔍 Executing query: SELECT * FROM receipts ORDER BY date');
      addDebugInfo(`🔓 Using authenticated access: ${user ? 'Authenticated' : 'Anonymous'}`);

      const { data, error } = await withTimeout(
        supabase
          .from('receipts')
          .select('*')
          .eq('company_id', companyId)
          .order('date'),
        8000
      );
      
      if (error) {
        addDebugInfo(`❌ Error fetching receipts: ${error.message}`);
        addDebugInfo(`❌ Error code: ${error.code}`);
        addDebugInfo(`❌ Error hint: ${error.hint}`);
        addDebugInfo(`❌ Error details: ${JSON.stringify(error.details)}`);
        throw error;
      }
      
      addDebugInfo(`📊 Database receipts raw data: ${JSON.stringify(data?.slice(0, 2))}... (showing first 2)`);
      addDebugInfo(`📊 Total receipts found: ${data?.length || 0}`);
      
      if (!data || data.length === 0) {
        addDebugInfo('📝 No receipts found in database');
        return [];
      }
      
      const mappedReceipts = data.map(r => {
        addDebugInfo(`🔄 Mapping receipt: ${r.receipt_number} (${r.id})`);
        return {
          id: r.id,
          receiptNumber: r.receipt_number,
          date: r.date,
          description: r.description,
          driverName: r.driver_name,
          expense: parseFloat(r.expense?.toString() || '0') || 0,
          postalCode: r.postal_code || undefined,
          city: r.city || undefined,
          createdBy: r.created_by || undefined,
          paymentMethod: (r.payment_method as 'bar' | 'uberweisung') || 'bar',
          merchantName: r.merchant_name || undefined,
          receiptTime: r.receipt_time || undefined,
          litres: numberOrUndefined(r.litres),
          pricePerLitre: numberOrUndefined(r.price_per_litre),
          odometerKm: numberOrUndefined(r.odometer_km),
          rangeKm: numberOrUndefined(r.range_km),
          submittedByName: r.submitted_by_name || undefined
        };
      });
      
      addDebugInfo(`✅ Mapped receipts: ${mappedReceipts.length} receipts`);
      addDebugInfo(`📋 Sample mapped receipt: ${JSON.stringify(mappedReceipts[0])}`);
      return mappedReceipts;
    } catch (error) {
      console.error('❌ Failed to get receipts from database:', error);
      addDebugInfo(`❌ Failed to get receipts from database: ${error instanceof Error ? error.message : 'Unknown error'}`);
      addDebugInfo(`❌ Stack trace: ${error instanceof Error ? error.stack : 'No stack trace'}`);
      addDebugInfo('📱 Falling back to localStorage for receipts');
      const saved = localStorage.getItem('receipts');
      return saved ? JSON.parse(saved) : [];
    }
  };

  const addReceipt = async (receipt: Omit<Receipt, 'id'>): Promise<Receipt> => {
    if (!isConnected) {
      refuseOfflineWrite();
    }

    try {
      addDebugInfo('🗄️ Adding receipt to database');
      addDebugInfo('🔓 Using authenticated access for insert');
      const { data, error } = await supabase
        .from('receipts')
        .insert({
          receipt_number: receipt.receiptNumber,
          date: receipt.date,
          description: receipt.description,
          driver_name: receipt.driverName,
          expense: receipt.expense,
          postal_code: receipt.postalCode || null,
          city: receipt.city || null,
          user_id: user?.id || null,
          created_by: user?.id || null,
          payment_method: receipt.paymentMethod || 'bar',
          merchant_name: receipt.merchantName ?? null,
          receipt_time: receipt.receiptTime ?? null,
          litres: receipt.litres ?? null,
          price_per_litre: receipt.pricePerLitre ?? null,
          odometer_km: receipt.odometerKm ?? null,
          range_km: receipt.rangeKm ?? null,
          company_id: companyId
        })
        .select()
        .single();
      
      if (error) {
        addDebugInfo(`❌ Error adding receipt: ${error.message}`);
        addDebugInfo(`❌ Error code: ${error.code}`);
        addDebugInfo(`❌ Error hint: ${error.hint}`);
        throw error;
      }
      
      addDebugInfo(`✅ Receipt added successfully: ${data.id}`);
      
      return {
        id: data.id,
        receiptNumber: data.receipt_number,
        date: data.date,
        description: data.description,
        driverName: data.driver_name,
        expense: parseFloat(data.expense) || 0,
        postalCode: data.postal_code || undefined,
        city: data.city || undefined,
        createdBy: data.created_by || undefined,
        paymentMethod: (data.payment_method as 'bar' | 'uberweisung') || 'bar'
      };
    } catch (error) {
      console.error('Failed to add receipt to database:', error);
      throw error;
    }
  };

  const updateReceipt = async (id: string, receipt: Partial<Receipt>): Promise<void> => {
    if (!isConnected) {
      refuseOfflineWrite();
    }

    try {
      const { error } = await supabase
        .from('receipts')
        .update({
          receipt_number: receipt.receiptNumber,
          date: receipt.date,
          description: receipt.description,
          driver_name: receipt.driverName,
          expense: receipt.expense,
          postal_code: receipt.postalCode || null,
          city: receipt.city || null,
          payment_method: receipt.paymentMethod || 'bar',
          merchant_name: receipt.merchantName ?? null,
          receipt_time: receipt.receiptTime ?? null,
          litres: receipt.litres ?? null,
          price_per_litre: receipt.pricePerLitre ?? null,
          odometer_km: receipt.odometerKm ?? null,
          range_km: receipt.rangeKm ?? null,
        })
        .eq('id', id);
      
      if (error) {
        console.error('Error updating receipt:', error);
        throw error;
      }
    } catch (error) {
      console.error('Failed to update receipt in database:', error);
      throw error;
    }
  };

  const deleteReceipt = async (id: string): Promise<void> => {
    if (!isConnected) {
      refuseOfflineWrite();
    }

    try {
      const { error } = await supabase
        .from('receipts')
        .delete()
        .eq('id', id);
      
      if (error) {
        console.error('Error deleting receipt:', error);
        throw error;
      }
    } catch (error) {
      console.error('Failed to delete receipt from database:', error);
      throw error;
    }
  };

  return {
    isConnected,
    isLoading,
    error,
    debugInfo,
    reconnect: checkConnection,
    drivers: {
      get: getDrivers,
      add: addDriver,
      update: updateDriver
    },
    receipts: {
      get: getReceipts,
      add: addReceipt,
      update: updateReceipt,
      delete: deleteReceipt
    }
  };
};