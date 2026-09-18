import React, { useState, useEffect } from 'react';
import { Plus, Download } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useDatabase } from '../hooks/useDatabase';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { Receipt, Driver } from '../types/receipt';
import ReceiptList, { PdfFilterInfo } from '../components/ReceiptList';
import ReceiptModal from '../components/ReceiptModal';
import ConfirmationModal from '../components/ConfirmationModal';
import { exportToExcel } from '../utils/excelExport';
import { handleDatabaseError } from '../utils/errorHandler';
import { generateReceiptPdf } from '../utils/receiptPdf';
import { supabase } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';

interface ConfirmModalState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  type: 'confirm' | 'warning';
}

const BelegePage: React.FC = () => {
  const { t } = useTranslation();
  const { user, canEdit, canDelete, canCreate } = useAuth();
  const { success, error: showError } = useToast();
  const { receipts: receiptActions, drivers: driverActions, isLoading: dbLoading } = useDatabase();
  const { settings } = useCompanySettings();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);
  const [userDisplayNames, setUserDisplayNames] = useState<Map<string, string>>(new Map());
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<Receipt | null>(null);
  const [filteredReceipts, setFilteredReceipts] = useState<Receipt[]>([]);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    type: 'confirm'
  });

  const canEditReceipt = (receipt: Receipt): boolean => canEdit(receipt.createdBy);
  const canDeleteReceipt = (receipt: Receipt): boolean => canDelete(receipt.createdBy);

  useEffect(() => {
    if (!dbLoading) loadData();
  }, [dbLoading]);

  useEffect(() => {
    setFilteredReceipts(receipts);
  }, [receipts]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [receiptsData, driversData, profilesRes] = await Promise.all([
        receiptActions.get(),
        driverActions.get(),
        supabase.from('user_profiles').select('user_id, full_name, email'),
      ]);
      setReceipts(receiptsData);
      setDrivers(driversData);
      const nameMap = new Map<string, string>();
      for (const p of profilesRes.data ?? []) {
        const display = (p.full_name as string | null)?.trim() || (p.email as string | null)?.trim() || '';
        if (p.user_id && display) nameMap.set(p.user_id as string, display);
      }
      setUserDisplayNames(nameMap);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddReceipt = async (receiptData: Omit<Receipt, 'id'>) => {
    if (!canCreate) {
      showError(t('common.noPermission'), t('belege.noPermissionAdd'));
      return;
    }
    try {
      await receiptActions.add(receiptData);
      await loadData();
    } catch (err) {
      console.error('Error adding receipt:', err);
      showError(t('common.errorCreate'), handleDatabaseError(err));
    }
  };

  const handleUpdateReceipt = async (id: string, receiptData: Omit<Receipt, 'id'>) => {
    try {
      await receiptActions.update(id, receiptData);
      await loadData();
      setEditingReceipt(null);
      setIsReceiptModalOpen(false);
      success(t('belege.updated'), t('belege.updatedBody'));
    } catch (err) {
      console.error('Error updating receipt:', err);
      showError(t('common.errorUpdate'), handleDatabaseError(err));
    }
  };

  const handleDeleteReceipt = (id: string) => {
    const receipt = receipts.find(r => r.id === id);
    if (!receipt) return;

    setConfirmModal({
      isOpen: true,
      title: t('belege.deleteTitle'),
      message: `Sind Sie sicher, dass Sie den Beleg #${receipt.receiptNumber} löschen möchten?`,
      onConfirm: async () => {
        try {
          await receiptActions.delete(id);
          await loadData();
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          success(t('belege.deleted'), t('belege.deletedBody'));
        } catch (err) {
          console.error('Error deleting receipt:', err);
          showError(t('common.errorDelete'), handleDatabaseError(err));
        }
      },
      type: 'confirm'
    });
  };

  const handleEditReceipt = (receipt: Receipt) => {
    setEditingReceipt(receipt);
    setIsReceiptModalOpen(true);
  };

  const handleExportExcel = () => {
    const toExport = filteredReceipts.length > 0 ? filteredReceipts : receipts;
    exportToExcel(toExport, 0, filteredReceipts.length > 0);
  };

  const handleDownloadPdf = (filtered: Receipt[], filterInfo: PdfFilterInfo) => {
    generateReceiptPdf(filtered, {
      ...filterInfo,
      companyName: settings?.company_name || 'El-Professor'
    });
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
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('nav.belege')}</h2>
        <div className="flex gap-2 sm:gap-4">
          <button
            onClick={() => {
              setEditingReceipt(null);
              setIsReceiptModalOpen(true);
            }}
            className="flex items-center justify-center rounded-lg transition-colors w-11 h-11 sm:w-auto sm:h-auto sm:px-4 sm:py-2"
            style={{ background: 'var(--success-solid)', color: 'white' }}
            title={t('belege.add')}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.9'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
          >
            <Plus className="w-5 h-5 sm:mr-2" />
            <span className="hidden sm:inline">{t('belege.add')}</span>
          </button>
          <button
            onClick={handleExportExcel}
            className="flex items-center justify-center rounded-lg transition-colors w-11 h-11 sm:w-auto sm:h-auto sm:px-4 sm:py-2"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            title={t('common.exportExcelShort')}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--accent-hover)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--accent)'; }}
          >
            <Download className="w-5 h-5 sm:mr-2" />
            <span className="hidden sm:inline">{t('common.exportExcelShort')}</span>
          </button>
        </div>
      </div>

      <ReceiptList
        receipts={receipts}
        drivers={drivers}
        onEdit={handleEditReceipt}
        onDelete={handleDeleteReceipt}
        onExportFiltered={(filtered) => setFilteredReceipts(filtered)}
        onDownloadPdf={handleDownloadPdf}
        canEdit={canEditReceipt}
        canDelete={canDeleteReceipt}
        userDisplayNames={userDisplayNames}
      />

      {isReceiptModalOpen && (
        <ReceiptModal
          isOpen={isReceiptModalOpen}
          onClose={() => {
            setIsReceiptModalOpen(false);
            setEditingReceipt(null);
          }}
          onSave={editingReceipt
            ? (data) => handleUpdateReceipt(editingReceipt.id, data)
            : handleAddReceipt
          }
          receipt={editingReceipt}
          title={editingReceipt ? t('belege.edit') : t('belege.new')}
          drivers={drivers}
          existingReceipts={receipts}
        />
      )}

      <ConfirmationModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        message={confirmModal.message}
        type={confirmModal.type}
      />
    </div>
  );
};

export default BelegePage;
