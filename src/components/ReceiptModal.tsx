import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Save, DollarSign, Receipt as ReceiptIcon, User, MapPin, CreditCard, Upload, Camera, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { Receipt, ReceiptFormData, Driver, PAYMENT_METHODS } from '../types/receipt';
import { getCityFromPostalCode, isValidGermanPostalCode } from '../utils/germanPostalCodes';
import { useToast } from '../contexts/ToastContext';
import { extractReceiptData, OcrResult, formatAmountDE } from '../utils/receiptOcr';

interface ReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: ReceiptFormData) => void;
  receipt?: Receipt;
  title: string;
  drivers: Driver[];
  existingReceipts: Receipt[];
}

const RECEIPT_CATEGORIES = [
  'Tanken',
  'Autowäsche',
  'Autozubehör',
  'Öl wechseln',
  'Other'
] as const;

type ReceiptCategory = typeof RECEIPT_CATEGORIES[number];

type ScanState = 'idle' | 'scanning' | 'success' | 'error';

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  outline: 'none',
  width: '100%',
};


const ReceiptModal: React.FC<ReceiptModalProps> = ({
  isOpen,
  onClose,
  onSave,
  receipt,
  title,
  drivers,
  existingReceipts,
}) => {
  const { success: showSuccess, error: showError } = useToast();
  const dateInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const [formData, setFormData] = useState<ReceiptFormData>({
    receiptNumber: '',
    date: '',
    description: '',
    driverName: '',
    expense: 0,
    postalCode: '',
    city: '',
    paymentMethod: 'bar',
  });

  const [selectedCategory, setSelectedCategory] = useState<ReceiptCategory>('Tanken');
  const [customDescription, setCustomDescription] = useState('');

  // Image scanning state
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanMessage, setScanMessage] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [showOcrDebug, setShowOcrDebug] = useState(false);
  // displayDate is the value shown in the text input: DD/MM/YYYY
  const [displayDate, setDisplayDate] = useState('');
  // displayAmount is the value shown in the text input: German comma format e.g. "41,47"
  const [displayAmount, setDisplayAmount] = useState('');

  // Parse German amount string "41,47" or "41.47" to number
  const parseDisplayAmount = (s: string): number => {
    const cleaned = s.trim().replace(/[^\d,\.]/g, '');
    // German: treat comma as decimal separator, dot as thousands separator
    const normalized = cleaned.includes(',')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned;
    const n = parseFloat(normalized);
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
  };

  // Convert ISO (YYYY-MM-DD) to display format (DD/MM/YYYY)
  const isoToDisplay = (iso: string): string => {
    if (!iso) return '';
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso;
    return `${m[3]}/${m[2]}/${m[1]}`;
  };

  // Parse display format (DD/MM/YYYY or DD.MM.YYYY) to ISO (YYYY-MM-DD)
  // Returns '' if input is incomplete/invalid
  const displayToIso = (display: string): string => {
    const cleaned = display.replace(/\./g, '/').trim();
    const m = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return '';
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3];
    const d = new Date(`${year}-${month}-${day}`);
    if (isNaN(d.getTime())) return '';
    return `${year}-${month}-${day}`;
  };

  const generateUniqueReceiptNumber = () => {
    const existingNumbers = new Set(existingReceipts.map(r => r.receiptNumber));
    let receiptNumber: string;
    do {
      const timestamp = Date.now();
      const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      receiptNumber = `BEL-${timestamp}-${random}`;
    } while (existingNumbers.has(receiptNumber));
    return receiptNumber;
  };

  useEffect(() => {
    if (!isOpen) return;
    if (receipt) {
      setFormData({
        receiptNumber: receipt.receiptNumber,
        date: receipt.date,
        description: receipt.description,
        driverName: receipt.driverName,
        expense: receipt.expense,
        postalCode: receipt.postalCode || '',
        city: receipt.city || '',
        paymentMethod: receipt.paymentMethod || 'bar',
      });
      const category = RECEIPT_CATEGORIES.find(cat => cat === receipt.description);
      if (category) {
        setSelectedCategory(category);
        setCustomDescription('');
      } else {
        setSelectedCategory('Other');
        setCustomDescription(receipt.description);
      }
    } else {
      resetForm();
    }
    // Reset scan state when modal opens
    setScanState('idle');
    setScanMessage('');
    setPreviewUrl(null);
    setOcrResult(null);
    setShowOcrDebug(false);
    // Sync display date
    const initialIso = receipt ? receipt.date : new Date().toISOString().split('T')[0];
    setDisplayDate(isoToDisplay(initialIso));
    // Sync display amount
    const initialExpense = receipt ? receipt.expense : 0;
    setDisplayAmount(initialExpense > 0 ? formatAmountDE(initialExpense) : '');
    setTimeout(() => { dateInputRef.current?.focus(); }, 100);
  }, [receipt, isOpen]);

  // Paste handler — listen globally while modal is open
  useEffect(() => {
    if (!isOpen) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) processImageFile(blob);
          break;
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isOpen]);

  const resetForm = (keepDriver = false) => {
    const today = new Date().toISOString().split('T')[0];
    setFormData(prev => ({
      receiptNumber: generateUniqueReceiptNumber(),
      date: today,
      description: 'Tanken',
      driverName: keepDriver ? prev.driverName : '',
      expense: 0,
      postalCode: '',
      city: '',
      paymentMethod: 'bar',
    }));
    setDisplayDate(isoToDisplay(today));
    setDisplayAmount('');
    setSelectedCategory('Tanken');
    setCustomDescription('');
  };

  const handlePostalCodeChange = async (value: string) => {
    const cleanValue = value.replace(/\D/g, '').slice(0, 5);
    if (cleanValue.length === 5 && isValidGermanPostalCode(cleanValue)) {
      setFormData(prev => ({ ...prev, postalCode: cleanValue, city: 'Lädt...' }));
      const city = await getCityFromPostalCode(cleanValue);
      setFormData(prev => ({ ...prev, postalCode: cleanValue, city: city || '' }));
    } else {
      setFormData(prev => ({ ...prev, postalCode: cleanValue, city: '' }));
    }
  };

  const handleCategoryChange = (category: ReceiptCategory) => {
    setSelectedCategory(category);
    if (category !== 'Other') {
      setFormData(prev => ({ ...prev, description: category }));
      setCustomDescription('');
    } else {
      setFormData(prev => ({ ...prev, description: customDescription }));
    }
  };

  const handleCustomDescriptionChange = (value: string) => {
    setCustomDescription(value);
    if (selectedCategory === 'Other') {
      setFormData(prev => ({ ...prev, description: value }));
    }
  };

  // ── Image processing & OCR ─────────────────────────────────────────────────

  const processImageFile = useCallback(async (file: File | Blob) => {
    if (!file.type.startsWith('image/')) {
      showError('Bitte ein Bild-Format wählen (JPEG, PNG, WebP)');
      return;
    }

    // Show preview
    const url = URL.createObjectURL(file);
    setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
    setScanState('scanning');
    setScanMessage('Belegdaten werden erkannt …');

    try {
      const data = await extractReceiptData(file, (pct) => {
        setScanMessage(`Texterkennung … ${pct}%`);
      });

      setOcrResult(data);

      const hasAnyField = data.date || data.receiptNumber || data.amount || data.postalCode;
      if (!hasAnyField) {
        setScanState('error');
        setScanMessage('Belegdaten konnten nicht vollständig erkannt werden. Bitte manuell ausfüllen.');
        return;
      }

      applyExtracted(data);
      setScanState('success');
      const uncertain = (data.dateReason?.startsWith('Unsicher') || data.amountReason?.startsWith('Unsicher'));
      setScanMessage(uncertain
        ? 'Felder erkannt — unsichere Felder bitte prüfen.'
        : 'Felder automatisch ausgefüllt — bitte prüfen und ggf. korrigieren.');
    } catch (err) {
      console.error('Receipt OCR error:', err);
      setScanState('error');
      setScanMessage('Belegdaten konnten nicht vollständig erkannt werden. Bitte manuell ausfüllen.');
    }
  }, []);

  // Map extracted data onto form fields
  const applyExtracted = useCallback(async (data: OcrResult) => {
    setFormData(prev => {
      const next = { ...prev };

      if (data.date?.match(/^\d{4}-\d{2}-\d{2}$/)) {
        next.date = data.date;
        setDisplayDate(isoToDisplay(data.date));
      }

      if (typeof data.amount === 'number' && data.amount > 0) {
        next.expense = Math.round(data.amount * 100) / 100;
        setDisplayAmount(formatAmountDE(next.expense));
      }

      if (data.postalCode?.match(/^\d{5}$/)) {
        next.postalCode = data.postalCode;
        // Apply OCR city immediately so the field is never left empty
        if (data.city?.trim()) {
          next.city = data.city.trim();
        }
      }

      return next;
    });

    if (data.category) {
      const cat = data.category as ReceiptCategory;
      if (RECEIPT_CATEGORIES.includes(cat)) {
        setSelectedCategory(cat);
        if (cat !== 'Other') {
          setFormData(prev => ({ ...prev, description: cat }));
          setCustomDescription('');
        }
      }
    }

    // Try the local PLZ database for a canonical city name; fall back to OCR city
    if (data.postalCode?.match(/^\d{5}$/)) {
      const dbCity = await getCityFromPostalCode(data.postalCode);
      if (dbCity) setFormData(prev => ({ ...prev, city: dbCity }));
      // If lookup fails, OCR city already written above — nothing to do
    }
  }, []);

  // Drag & drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processImageFile(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processImageFile(file);
    e.target.value = '';
  };

  const clearImage = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setScanState('idle');
    setScanMessage('');
    setOcrResult(null);
    setShowOcrDebug(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalDescription = selectedCategory === 'Other' ? customDescription : selectedCategory;
    if (!finalDescription.trim()) return;
    if (!formData.receiptNumber.trim() || !formData.driverName) return;
    if (!formData.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      showError('Bitte ein gültiges Datum eingeben (TT/MM/JJJJ)');
      dateInputRef.current?.focus();
      return;
    }

    await onSave({ ...formData, description: finalDescription });
    showSuccess('Beleg erfolgreich gespeichert');

    if (!receipt) {
      resetForm(true);
      clearImage();
      setTimeout(() => { dateInputRef.current?.focus(); }, 100);
    }
  };

  if (!isOpen) return null;

  // ── Scan zone styles ───────────────────────────────────────────────────────
  const scanZoneBorder =
    isDragOver
      ? '2px dashed var(--accent)'
      : scanState === 'success'
      ? '2px dashed #16a34a'
      : scanState === 'error'
      ? '2px dashed var(--danger)'
      : '2px dashed var(--border)';

  const scanZoneBg =
    isDragOver
      ? 'rgba(var(--accent-rgb,37,99,235),0.06)'
      : scanState === 'success'
      ? 'rgba(22,163,74,0.05)'
      : scanState === 'error'
      ? 'rgba(var(--danger-rgb,220,38,38),0.05)'
      : 'var(--bg-subtle)';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div
        style={{ background: 'var(--bg-surface)', borderRadius: '0.5rem', boxShadow: 'var(--shadow-lg)', maxHeight: '92vh', overflowY: 'auto' }}
        className="w-full max-w-md"
      >
        {/* Header */}
        <div style={{ borderBottom: '1px solid var(--border)' }} className="flex items-center justify-between p-6 sticky top-0 z-10" style2={{ background: 'var(--bg-surface)' }}>
          <h2 style={{ color: 'var(--text-primary)' }} className="text-xl font-semibold flex items-center space-x-2">
            <ReceiptIcon size={20} />
            <span>{title}</span>
          </h2>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-4">

          {/* ── Image scan zone (only in create mode) ── */}
          {!receipt && (
            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2 flex items-center gap-1.5">
                <Camera size={14} />
                Belegbild einfügen oder hochladen
              </label>

              {/* Drop zone */}
              <div
                ref={dropZoneRef}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => { if (!previewUrl) fileInputRef.current?.click(); }}
                style={{
                  border: scanZoneBorder,
                  borderRadius: '0.625rem',
                  background: scanZoneBg,
                  transition: 'all 0.15s',
                  cursor: previewUrl ? 'default' : 'pointer',
                  minHeight: previewUrl ? 'auto' : '88px',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                {/* Preview image */}
                {previewUrl && (
                  <div style={{ position: 'relative' }}>
                    <img
                      src={previewUrl}
                      alt="Belegvorschau"
                      style={{
                        width: '100%',
                        maxHeight: '180px',
                        objectFit: 'contain',
                        display: 'block',
                        background: '#000',
                        borderRadius: '0.5rem 0.5rem 0 0',
                      }}
                    />
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); clearImage(); }}
                      style={{
                        position: 'absolute', top: 6, right: 6,
                        background: 'rgba(0,0,0,0.6)', color: '#fff',
                        borderRadius: '50%', width: 24, height: 24,
                        border: 'none', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                      title="Bild entfernen"
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}

                {/* Empty state prompt */}
                {!previewUrl && (
                  <div className="flex flex-col items-center justify-center gap-2 py-5 px-4">
                    <div style={{ color: isDragOver ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                      <Upload size={22} />
                    </div>
                    <p style={{ color: 'var(--text-tertiary)', fontSize: '0.8125rem', textAlign: 'center', margin: 0 }}>
                      Bild hier ablegen, einfügen{' '}
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>(Strg+V)</span>
                      {' '}oder{' '}
                      <span style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'underline' }}>
                        Datei wählen
                      </span>
                    </p>
                    <p style={{ color: 'var(--text-tertiary)', fontSize: '0.6875rem', margin: 0 }}>
                      JPEG · PNG · WebP
                    </p>
                  </div>
                )}

                {/* Status bar below image */}
                {previewUrl && (
                  <div
                    style={{
                      padding: '8px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      borderTop: '1px solid var(--border)',
                    }}
                  >
                    {scanState === 'scanning' && (
                      <>
                        <Loader2 size={14} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite' }} />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{scanMessage}</span>
                      </>
                    )}
                    {scanState === 'success' && (
                      <>
                        <CheckCircle size={14} style={{ color: '#16a34a', flexShrink: 0 }} />
                        <span style={{ fontSize: '0.75rem', color: '#16a34a' }}>{scanMessage}</span>
                      </>
                    )}
                    {scanState === 'error' && (
                      <>
                        <AlertCircle size={14} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                        <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>{scanMessage}</span>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={handleFileInputChange}
              />

              {/* Upload button (always visible as secondary action) */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  marginTop: 6,
                  width: '100%',
                  padding: '0.375rem 0.75rem',
                  borderRadius: '0.5rem',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-subtle)',
                  color: 'var(--text-secondary)',
                  fontSize: '0.8125rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
              >
                <Upload size={13} />
                Belegfoto hochladen
              </button>

              {/* OCR debug panel */}
              {ocrResult && scanState === 'success' && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => setShowOcrDebug(v => !v)}
                    style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    {showOcrDebug ? '▾' : '▸'} OCR-Kandidaten anzeigen
                  </button>
                  {showOcrDebug && (
                    <div style={{ fontSize: '0.68rem', marginTop: 4, padding: '8px', borderRadius: '0.375rem', background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                      {ocrResult.amountCandidates && ocrResult.amountCandidates.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <strong style={{ color: 'var(--text-secondary)' }}>Betrag-Kandidaten:</strong>
                          {ocrResult.amountCandidates.map((c, i) => (
                            <div key={i} style={{ paddingLeft: 8, color: c.rejected ? '#f87171' : i === 0 ? '#86efac' : 'var(--text-tertiary)' }}>
                              {c.rejected ? '✗ ' : i === 0 ? '✓ ' : '  '}
                              {c.value}
                              {c.rejected
                                ? ` — Abgelehnt: ${c.rejectedReason}`
                                : ` (Score ${c.score}) — ${c.reason}`}
                              <span style={{ opacity: 0.6 }}> [{c.sourceLine.slice(0, 40)}]</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {ocrResult.dateCandidates && ocrResult.dateCandidates.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <strong style={{ color: 'var(--text-secondary)' }}>Datum-Kandidaten:</strong>
                          {ocrResult.dateCandidates.map((c, i) => (
                            <div key={i} style={{ paddingLeft: 8, color: c.rejected ? '#f87171' : i === 0 ? '#86efac' : 'var(--text-tertiary)' }}>
                              {c.rejected ? '✗ ' : i === 0 ? '✓ ' : '  '}
                              {c.value} (Score {c.score}) — {c.reason}
                              <span style={{ opacity: 0.6 }}> [{c.sourceLine.slice(0, 40)}]</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div>
                        <strong style={{ color: 'var(--text-secondary)' }}>PLZ/Stadt-Kandidaten:</strong>
                        {(!ocrResult.plzCandidates || ocrResult.plzCandidates.length === 0) ? (
                          <div style={{ paddingLeft: 8, color: '#f87171' }}>Keine PLZ/Stadt-Kandidaten gefunden</div>
                        ) : (
                          ocrResult.plzCandidates.map((c, i) => (
                            <div key={i} style={{ paddingLeft: 8, color: c.rejected ? '#f87171' : i === 0 ? '#86efac' : 'var(--text-tertiary)' }}>
                              {c.rejected ? '✗ ' : i === 0 ? '✓ ' : '  '}
                              {c.postalCode} {c.city}
                              {c.rejected
                                ? ` — Abgelehnt: ${c.rejectedReason}`
                                : ` (Score ${c.score}) — ${c.reason}`}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--border)', marginTop: '1rem' }} />
            </div>
          )}

          {/* ── Main form ── */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                Belegnummer
              </label>
              <div className="relative">
                <ReceiptIcon style={{ color: 'var(--text-tertiary)' }} className="absolute left-3 top-1/2 transform -translate-y-1/2" size={16} />
                <input
                  type="text"
                  value={formData.receiptNumber}
                  onChange={e => setFormData(prev => ({ ...prev, receiptNumber: e.target.value }))}
                  style={{ ...inputStyle, paddingLeft: '2.25rem' }}
                  placeholder="Automatisch generiert"
                  required
                />
              </div>
            </div>

            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1 flex items-center gap-2">
                Datum
                {ocrResult?.dateReason?.startsWith('Unsicher') && (
                  <span style={{ fontSize: '0.7rem', color: '#f59e0b', fontWeight: 600 }}>Bitte prüfen</span>
                )}
              </label>
              <input
                ref={dateInputRef}
                type="text"
                inputMode="numeric"
                placeholder="TT/MM/JJJJ"
                value={displayDate}
                onChange={e => {
                  const raw = e.target.value;
                  setDisplayDate(raw);
                  const iso = displayToIso(raw);
                  if (iso) setFormData(prev => ({ ...prev, date: iso }));
                }}
                onBlur={e => {
                  // On blur, re-format if valid so partial entries become clean
                  const iso = displayToIso(e.target.value);
                  if (iso) setDisplayDate(isoToDisplay(iso));
                }}
                style={{
                  ...inputStyle,
                  borderColor: ocrResult?.dateReason?.startsWith('Unsicher') ? '#f59e0b' : undefined,
                  boxShadow: ocrResult?.dateReason?.startsWith('Unsicher') ? '0 0 0 1px #f59e0b' : undefined,
                }}
              />
              {/* Hidden native date for form validation — keeps formData.date in sync */}
              <input
                type="hidden"
                name="date"
                value={formData.date}
                required
              />
              {ocrResult?.dateReason && (
                <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: 3 }}>
                  OCR: {ocrResult.dateReason}
                </p>
              )}
            </div>

            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                Fahrer
              </label>
              <div className="relative">
                <User style={{ color: 'var(--text-tertiary)' }} className="absolute left-3 top-1/2 transform -translate-y-1/2" size={16} />
                <select
                  value={formData.driverName}
                  onChange={e => setFormData({ ...formData, driverName: e.target.value })}
                  style={{ ...inputStyle, paddingLeft: '2.25rem', appearance: 'none' }}
                  required
                >
                  <option value="">Fahrer auswählen</option>
                  {drivers.filter(d => d.status !== 'inactive').map(d => (
                    <option key={d.id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                Kategorie
              </label>
              <select
                value={selectedCategory}
                onChange={e => handleCategoryChange(e.target.value as ReceiptCategory)}
                style={{ ...inputStyle, appearance: 'none' }}
                required
              >
                {RECEIPT_CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>

            {selectedCategory === 'Other' && (
              <div>
                <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                  Beschreibung
                </label>
                <input
                  type="text"
                  value={customDescription}
                  onChange={e => handleCustomDescriptionChange(e.target.value)}
                  style={inputStyle}
                  placeholder="Bitte Beschreibung eingeben"
                  required
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                  Postleitzahl
                </label>
                <div className="relative">
                  <MapPin style={{ color: 'var(--text-tertiary)' }} className="absolute left-3 top-1/2 transform -translate-y-1/2" size={16} />
                  <input
                    type="text"
                    value={formData.postalCode || ''}
                    onChange={e => handlePostalCodeChange(e.target.value)}
                    style={{ ...inputStyle, paddingLeft: '2.25rem' }}
                    placeholder="z.B. 10115"
                    maxLength={5}
                  />
                </div>
              </div>
              <div>
                <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                  Stadt
                </label>
                <input
                  type="text"
                  value={formData.city || ''}
                  readOnly
                  style={{ ...inputStyle, opacity: 0.7 }}
                  placeholder="Automatisch erkannt"
                />
              </div>
            </div>

            <div>
              <label style={{ color: 'var(--danger)' }} className="block text-sm font-medium mb-1 flex items-center gap-2">
                Ausgaben €
                {ocrResult?.amountReason?.startsWith('Unsicher') && (
                  <span style={{ fontSize: '0.7rem', color: '#f59e0b', fontWeight: 600 }}>Bitte prüfen</span>
                )}
              </label>
              <div className="relative">
                <DollarSign style={{ color: 'var(--danger)' }} className="absolute left-3 top-1/2 transform -translate-y-1/2" size={16} />
                <input
                  type="text"
                  inputMode="decimal"
                  value={displayAmount}
                  onChange={e => {
                    const raw = e.target.value;
                    setDisplayAmount(raw);
                    const n = parseDisplayAmount(raw);
                    setFormData(prev => ({ ...prev, expense: n }));
                  }}
                  onBlur={e => {
                    const n = parseDisplayAmount(e.target.value);
                    if (n > 0) {
                      setDisplayAmount(formatAmountDE(n));
                      setFormData(prev => ({ ...prev, expense: n }));
                    }
                  }}
                  style={{
                    ...inputStyle,
                    paddingLeft: '2.25rem',
                    borderColor: ocrResult?.amountReason?.startsWith('Unsicher') ? '#f59e0b' : undefined,
                    boxShadow: ocrResult?.amountReason?.startsWith('Unsicher') ? '0 0 0 1px #f59e0b' : undefined,
                  }}
                  placeholder="0,00"
                />
              </div>
              {ocrResult?.amountReason && (
                <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: 3 }}>
                  OCR: {ocrResult.amountReason}
                </p>
              )}
            </div>

            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                Zahlungsmethode
              </label>
              <div className="relative">
                <CreditCard style={{ color: 'var(--text-tertiary)' }} className="absolute left-3 top-1/2 transform -translate-y-1/2" size={16} />
                <select
                  value={formData.paymentMethod || 'bar'}
                  onChange={e => setFormData({ ...formData, paymentMethod: e.target.value as 'bar' | 'uberweisung' })}
                  style={{ ...inputStyle, paddingLeft: '2.25rem', appearance: 'none' }}
                  required
                >
                  <option value="bar">{PAYMENT_METHODS.bar}</option>
                  <option value="uberweisung">{PAYMENT_METHODS.uberweisung}</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.5rem 1rem' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
              >
                Abbrechen
              </button>
              <button
                type="submit"
                disabled={scanState === 'scanning'}
                style={{
                  background: scanState === 'scanning' ? 'var(--bg-muted)' : 'var(--accent)',
                  color: scanState === 'scanning' ? 'var(--text-tertiary)' : 'var(--accent-text)',
                  borderRadius: '0.5rem',
                  padding: '0.5rem 1rem',
                  border: 'none',
                  cursor: scanState === 'scanning' ? 'not-allowed' : 'pointer',
                }}
                className="flex items-center space-x-2"
                onMouseEnter={e => { if (scanState !== 'scanning') e.currentTarget.style.background = 'var(--accent-hover)'; }}
                onMouseLeave={e => { if (scanState !== 'scanning') e.currentTarget.style.background = 'var(--accent)'; }}
              >
                {scanState === 'scanning' ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={16} />}
                <span>{scanState === 'scanning' ? 'Erkenne …' : 'Speichern'}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default ReceiptModal;
