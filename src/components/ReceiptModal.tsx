import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AlertCircle, Camera, CheckCircle, ChevronRight, Loader2, Receipt as ReceiptIcon, Save, Upload, X } from 'lucide-react';
import { Receipt, ReceiptFormData, Driver } from '../types/receipt';
import { getCityFromPostalCode, isValidGermanPostalCode } from '../utils/germanPostalCodes';
import { useToast } from '../contexts/ToastContext';
import { extractReceiptData, OcrResult, formatAmountDE } from '../utils/receiptOcr';
import { useTranslation } from '../contexts/LanguageContext';
import { localReceiptNumber, nextReceiptNumber } from '../lib/receiptNumber';
import type { TranslationKey } from '../i18n';
import {
  EMPTY_DETAILS,
  RECEIPT_CATEGORIES,
  detailsFieldsFromReceipt,
  hasFuelFigures,
  receiptDetailsProblem,
  receiptDetailsValues,
  type ReceiptCategory,
  type ReceiptDetailsFields,
} from '../utils/receiptFormRules';
import {
  Badge,
  Button,
  cn,
  Field,
  Input,
  NativeSelect,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './ui';

interface ReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: ReceiptFormData) => void;
  receipt?: Receipt;
  title: string;
  drivers: Driver[];
  existingReceipts: Receipt[];
}

// The category values (utils/receiptFormRules.ts) are written to
// `receipts.description` and compared on read. `Tanken` in particular selects
// the receipts that feed the Tankenquote, so the stored string must stay
// byte-identical. Only the label below is translated.

// `label` holds a TranslationKey: this map is module-level and t() is a hook
// value, so every consumer resolves it at the call site.
const RECEIPT_CATEGORY_LABELS: Record<ReceiptCategory, TranslationKey> = {
  'Tanken':       'rec.category.tanken',
  'Autowäsche':   'rec.category.carWash',
  'Autozubehör':  'rec.category.carAccessories',
  'Öl wechseln':  'rec.category.oilChange',
  'Other':        'rec.category.other',
};

type ScanState = 'idle' | 'scanning' | 'success' | 'error';

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
  const { t } = useTranslation();
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
  // What the driver app captures beyond the base fields. Postal code and city
  // stay in formData; the rest are typed text until saved
  // (utils/receiptFormRules.ts decides what they mean and what is refused).
  const [details, setDetails] = useState<ReceiptDetailsFields>(EMPTY_DETAILS);
  const setDetail = (key: keyof ReceiptDetailsFields, value: string) =>
    setDetails(prev => ({ ...prev, [key]: value }));
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

  // The provisional number, so the field is never empty while the server
  // answers. `20261005100000` moved the authoritative draw to
  // `receipt_number_next()`, under a partial unique index on this shape — the
  // browser cannot see another tab's or the partner intake path's numbers, and
  // this check never could.
  const generateUniqueReceiptNumber = () =>
    localReceiptNumber(existingReceipts.map(r => r.receiptNumber));

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
      setDetails(detailsFieldsFromReceipt(receipt));
      const category = RECEIPT_CATEGORIES.find(cat => cat === receipt.description);
      if (category) {
        setSelectedCategory(category);
        setCustomDescription('');
      } else {
        setSelectedCategory('Other');
        setCustomDescription(receipt.description);
      }
    } else {
      const provisional = generateUniqueReceiptNumber();
      resetForm(false, provisional);
      // Then replace it with the number the server drew, which is the only one
      // checked against every writer. A failure leaves the provisional one in
      // place rather than blocking the entry, and the partial unique index still
      // refuses a real collision on write. A number the user has already edited
      // is never overwritten — that is what comparing against `provisional` is.
      void nextReceiptNumber().then(drawn => {
        if (!drawn) return;
        setFormData(prev =>
          prev.receiptNumber === provisional ? { ...prev, receiptNumber: drawn } : prev,
        );
      });
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

  const resetForm = (keepDriver = false, receiptNumber?: string) => {
    const today = new Date().toISOString().split('T')[0];
    setFormData(prev => ({
      receiptNumber: receiptNumber ?? generateUniqueReceiptNumber(),
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
    setDetails(EMPTY_DETAILS);
  };

  const handlePostalCodeChange = async (value: string) => {
    const cleanValue = value.replace(/\D/g, '').slice(0, 5);
    if (cleanValue.length === 5 && isValidGermanPostalCode(cleanValue)) {
      setFormData(prev => ({ ...prev, postalCode: cleanValue, city: t('rec.cityLoading') }));
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
      showError(t('rec.ocr.invalidImage'));
      return;
    }

    // Show preview
    const url = URL.createObjectURL(file);
    setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
    setScanState('scanning');
    setScanMessage(t('rec.ocr.detecting'));

    try {
      const data = await extractReceiptData(file, (pct) => {
        setScanMessage(t('rec.ocr.progress', { percent: pct }));
      });

      setOcrResult(data);

      const hasAnyField = data.date || data.receiptNumber || data.amount || data.postalCode;
      if (!hasAnyField) {
        setScanState('error');
        setScanMessage(t('rec.ocr.failed'));
        return;
      }

      applyExtracted(data);
      setScanState('success');
      // 'Unsicher' is the marker receiptOcr.ts writes into its reason strings, not
      // display text — matching it must not follow the UI language.
      const uncertain = (data.dateReason?.startsWith('Unsicher') || data.amountReason?.startsWith('Unsicher'));
      setScanMessage(uncertain
        ? t('rec.ocr.successUncertain')
        : t('rec.ocr.success'));
    } catch (err) {
      console.error('Receipt OCR error:', err);
      setScanState('error');
      setScanMessage(t('rec.ocr.failed'));
    }
  }, [t]);

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
      showError(t('rec.invalidDate'));
      dateInputRef.current?.focus();
      return;
    }

    const fields: ReceiptDetailsFields = {
      ...details,
      postalCode: formData.postalCode ?? '',
      city: formData.city ?? '',
    };
    const problem = receiptDetailsProblem(finalDescription, fields, receipt ? 'edit' : 'create');
    if (problem) {
      showError(t(problem));
      return;
    }

    await onSave({
      ...formData,
      description: finalDescription,
      postalCode: fields.postalCode.trim() || undefined,
      city: fields.city.trim() || undefined,
      ...receiptDetailsValues(finalDescription, fields),
    });
    showSuccess(t('rec.saved'));

    if (!receipt) {
      resetForm(true);
      clearImage();
      setTimeout(() => { dateInputRef.current?.focus(); }, 100);
    }
  };

  if (!isOpen) return null;

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the form's logic and is unchanged, except the
  // module-level inline input style object, which only drew. The Belegnummer is
  // generateUniqueReceiptNumber()'s (BEL-{timestamp}-{random}, checked against
  // every existing number); applyExtracted() never writes it, whatever the OCR
  // reads. The field below binds the same value with the same handler as
  // before. Everything below only draws; the scan zone's border and fill, which
  // used to be computed here as inline styles, are a class map now.

  const formId = 'receipt-form';

  // 'Unsicher' is the marker receiptOcr.ts writes into its reason strings, not
  // display text (see processImageFile).
  const dateUncertain = ocrResult?.dateReason?.startsWith('Unsicher');
  const amountUncertain = ocrResult?.amountReason?.startsWith('Unsicher');
  const uncertainField = 'border-caution ring-1 ring-caution';

  // The same order of precedence as the old inline styles.
  const scanZoneTone = isDragOver
    ? 'border-brand bg-brand-soft'
    : scanState === 'success'
    ? 'border-positive/60 bg-positive-soft'
    : scanState === 'error'
    ? 'border-critical/60 bg-critical-soft'
    : 'border-line-strong bg-sunken';

  const candidateTone = (rejected: boolean | undefined, index: number) =>
    rejected ? 'text-critical' : index === 0 ? 'text-positive' : 'text-fg-subtle';

  const labelWithCheck = (label: string, uncertain: boolean | undefined) => (
    <span className="inline-flex flex-wrap items-center gap-2">
      {label}
      {uncertain && <Badge tone="caution">{t('rec.pleaseCheck')}</Badge>}
    </span>
  );

  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        // A click beside the form must not throw away what was typed; the old
        // modal ignored it as well. Escape and the close button still close.
        onInteractOutside={event => event.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ReceiptIcon aria-hidden className="size-5 text-fg-subtle" />
            {title}
          </SheetTitle>
          <SheetDescription>{t('rec.formDescription')}</SheetDescription>
        </SheetHeader>

        <SheetBody>
          <div className="grid gap-6">
            {/* ── Image scan zone (only in create mode) ── */}
            {!receipt && (
              <section aria-label={t('rec.scanLabel')} className="grid gap-2 border-b border-line pb-6">
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-fg-muted">
                  <Camera aria-hidden className="size-3.5" />
                  {t('rec.scanLabel')}
                </p>

                {/* The drop zone takes a drop, a paste anywhere in the form, or a
                    click; the button under it is the keyboard's way in. */}
                <div
                  ref={dropZoneRef}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => { if (!previewUrl) fileInputRef.current?.click(); }}
                  className={cn(
                    'relative overflow-hidden rounded-surface border-2 border-dashed transition-colors',
                    scanZoneTone,
                    previewUrl ? 'cursor-default' : 'min-h-[88px] cursor-pointer',
                  )}
                >
                  {previewUrl && (
                    <div className="relative">
                      <img src={previewUrl} alt={t('rec.previewAlt')} className="block max-h-[180px] w-full bg-sunken object-contain" />
                      <Button
                        variant="secondary"
                        size="icon-sm"
                        className="absolute right-1.5 top-1.5 rounded-full"
                        onClick={e => { e.stopPropagation(); clearImage(); }}
                        aria-label={t('rec.removeImage')}
                      >
                        <X aria-hidden />
                      </Button>
                    </div>
                  )}

                  {!previewUrl && (
                    <div className="flex flex-col items-center justify-center gap-2 px-4 py-5 text-center">
                      <Upload aria-hidden className={cn('size-5', isDragOver ? 'text-brand-text' : 'text-fg-subtle')} />
                      <p className="text-[13px] text-fg-muted">
                        {t('rec.dropHint')}{' '}
                        <span className="font-semibold text-brand-text">{t('rec.dropShortcut')}</span>
                        {' '}{t('rec.dropOr')}{' '}
                        <span className="font-semibold text-brand-text underline">{t('rec.chooseFile')}</span>
                      </p>
                      <p className="text-[11px] text-fg-subtle">JPEG · PNG · WebP</p>
                    </div>
                  )}

                  {previewUrl && (
                    <div role="status" className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs">
                      {scanState === 'scanning' && (
                        <>
                          <Loader2 aria-hidden className="size-3.5 shrink-0 text-brand-text motion-safe:animate-spin" />
                          <span className="text-fg-muted">{scanMessage}</span>
                        </>
                      )}
                      {scanState === 'success' && (
                        <>
                          <CheckCircle aria-hidden className="size-3.5 shrink-0 text-positive" />
                          <span className="text-positive">{scanMessage}</span>
                        </>
                      )}
                      {scanState === 'error' && (
                        <>
                          <AlertCircle aria-hidden className="size-3.5 shrink-0 text-critical" />
                          <span className="text-critical">{scanMessage}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={handleFileInputChange}
                />

                <Button variant="secondary" size="sm" className="w-full" onClick={() => fileInputRef.current?.click()}>
                  <Upload aria-hidden />
                  {t('rec.uploadPhoto')}
                </Button>

                {/* OCR diagnostics: the candidates and reasons come from
                    receiptOcr.ts and stay German. */}
                {ocrResult && scanState === 'success' && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowOcrDebug(v => !v)}
                      aria-expanded={showOcrDebug}
                      className="inline-flex items-center gap-1 rounded-sm text-xs text-fg-subtle transition-colors hover:text-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', showOcrDebug && 'rotate-90')} />
                      {t('rec.ocr.showCandidates')}
                    </button>
                    {showOcrDebug && (
                      <div className="mt-1 grid gap-1.5 rounded-control bg-sunken p-2 text-[11px] leading-relaxed text-fg-muted">
                        {ocrResult.amountCandidates && ocrResult.amountCandidates.length > 0 && (
                          <div>
                            <strong className="text-fg">{t('rec.ocr.amountCandidates')}</strong>
                            {ocrResult.amountCandidates.map((c, i) => (
                              <div key={i} className={cn('pl-2', candidateTone(c.rejected, i))}>
                                {c.rejected ? '✗ ' : i === 0 ? '✓ ' : '  '}
                                {c.value}
                                {c.rejected
                                  ? t('rec.ocr.rejectedReason', { reason: c.rejectedReason ?? '' })
                                  : t('rec.ocr.scoredReason', { score: c.score, reason: c.reason })}
                                <span className="opacity-70"> [{c.sourceLine.slice(0, 40)}]</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {ocrResult.dateCandidates && ocrResult.dateCandidates.length > 0 && (
                          <div>
                            <strong className="text-fg">{t('rec.ocr.dateCandidates')}</strong>
                            {ocrResult.dateCandidates.map((c, i) => (
                              <div key={i} className={cn('pl-2', candidateTone(c.rejected, i))}>
                                {c.rejected ? '✗ ' : i === 0 ? '✓ ' : '  '}
                                {c.value}{t('rec.ocr.scoredReason', { score: c.score, reason: c.reason })}
                                <span className="opacity-70"> [{c.sourceLine.slice(0, 40)}]</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div>
                          <strong className="text-fg">{t('rec.ocr.plzCandidates')}</strong>
                          {(!ocrResult.plzCandidates || ocrResult.plzCandidates.length === 0) ? (
                            <div className="pl-2 text-critical">{t('rec.ocr.noPlzCandidates')}</div>
                          ) : (
                            ocrResult.plzCandidates.map((c, i) => (
                              <div key={i} className={cn('pl-2', candidateTone(c.rejected, i))}>
                                {c.rejected ? '✗ ' : i === 0 ? '✓ ' : '  '}
                                {c.postalCode} {c.city}
                                {c.rejected
                                  ? t('rec.ocr.rejectedReason', { reason: c.rejectedReason ?? '' })
                                  : t('rec.ocr.scoredReason', { score: c.score, reason: c.reason })}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* ── Main form ── */}
            <form id={formId} onSubmit={handleSubmit} className="grid gap-5">
              {/* One form, four groups. The fuel group is the driver app's
                  refuel step: it exists only for the refuel category, and the
                  rules behind every field are utils/receiptFormRules.ts. */}
              <section className="grid gap-4">
                <h3 className="border-b border-line pb-1.5 text-[13px] font-semibold text-fg">
                  {t('rec.section.identity')}
                </h3>
                <Field label={t('rec.receiptNumber')} required>
                  <Input
                    type="text"
                    value={formData.receiptNumber}
                    onChange={e => setFormData(prev => ({ ...prev, receiptNumber: e.target.value }))}
                    className="tabular-nums"
                    placeholder={t('rec.autoGenerated')}
                    required
                  />
                </Field>

                <Field label={t('common.driver')} required>
                  <NativeSelect
                    value={formData.driverName}
                    onChange={e => setFormData({ ...formData, driverName: e.target.value })}
                    required
                  >
                    <option value="">{t('rec.selectDriver')}</option>
                    {drivers.filter(d => d.status !== 'inactive').map(d => (
                      <option key={d.id} value={d.name}>{d.name}</option>
                    ))}
                  </NativeSelect>
                </Field>

                <Field label={t('rec.category')} required>
                  <NativeSelect
                    value={selectedCategory}
                    onChange={e => handleCategoryChange(e.target.value as ReceiptCategory)}
                    required
                  >
                    {/* The option value is the persisted category; only the label translates. */}
                    {RECEIPT_CATEGORIES.map(cat => (
                      <option key={cat} value={cat}>{t(RECEIPT_CATEGORY_LABELS[cat])}</option>
                    ))}
                  </NativeSelect>
                </Field>

                {selectedCategory === 'Other' && (
                  <Field label={t('common.description')} required>
                    <Input
                      type="text"
                      value={customDescription}
                      onChange={e => handleCustomDescriptionChange(e.target.value)}
                      placeholder={t('rec.descriptionPlaceholder')}
                      required
                    />
                  </Field>
                )}
              </section>

              <section className="grid gap-4">
                <h3 className="border-b border-line pb-1.5 text-[13px] font-semibold text-fg">
                  {t('rec.section.whereWhen')}
                </h3>
                <Field label={t('rec.merchant')} required={!receipt}>
                  <Input
                    type="text"
                    value={details.merchant}
                    onChange={e => setDetail('merchant', e.target.value)}
                    placeholder={t('rec.merchantPlaceholder')}
                  />
                </Field>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t('rec.postalCode')}>
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={formData.postalCode || ''}
                      onChange={e => handlePostalCodeChange(e.target.value)}
                      placeholder={t('rec.postalCodePlaceholder')}
                      maxLength={5}
                    />
                  </Field>
                  <Field label={t('rec.city')} hint={t('rec.autoDetected')} required={!receipt}>
                    <Input
                      type="text"
                      value={formData.city || ''}
                      onChange={e => setFormData(prev => ({ ...prev, city: e.target.value }))}
                    />
                  </Field>
                </div>

                <Field
                  label={labelWithCheck(t('common.date'), dateUncertain)}
                  // dateReason is OCR diagnostics produced in German by receiptOcr.ts.
                  hint={ocrResult?.dateReason ? <>OCR: {ocrResult.dateReason}</> : undefined}
                >
                  {/* The mask is day-first in both languages, because displayToIso
                      parses DD.MM.YYYY / DD/MM/YYYY only and the figure matches the
                      Beleg. Only the letters naming the fields follow the UI
                      language (TT/MM/JJJJ → DD/MM/YYYY); the order never does. */}
                  <Input
                    ref={dateInputRef}
                    type="text"
                    inputMode="numeric"
                    placeholder={t('rec.datePlaceholder')}
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
                    className={cn(dateUncertain && uncertainField)}
                  />
                </Field>
                {/* Hidden native date for form validation — keeps formData.date in sync */}
                <input
                  type="hidden"
                  name="date"
                  value={formData.date}
                  required
                />

                <Field label={t('rec.receiptTime')} hint={t('rec.receiptTimeHint')} required={!receipt}>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={details.receiptTime}
                    onChange={e => setDetail('receiptTime', e.target.value)}
                    placeholder="14:32"
                    maxLength={5}
                    className="tabular-nums"
                  />
                </Field>
              </section>

              <section className="grid gap-4">
                <h3 className="border-b border-line pb-1.5 text-[13px] font-semibold text-fg">
                  {t('rec.section.money')}
                </h3>
                <Field
                  label={labelWithCheck(t('rec.expensesEuro'), amountUncertain)}
                  // amountReason is OCR diagnostics produced in German by receiptOcr.ts.
                  hint={ocrResult?.amountReason ? <>OCR: {ocrResult.amountReason}</> : undefined}
                >
                  <Input
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
                    className={cn('tabular-nums', amountUncertain && uncertainField)}
                    placeholder="0,00"
                  />
                </Field>

                <Field label={t('rec.paymentMethod')} required>
                  <NativeSelect
                    value={formData.paymentMethod || 'bar'}
                    onChange={e => setFormData({ ...formData, paymentMethod: e.target.value as 'bar' | 'uberweisung' })}
                    required
                  >
                    {/* PAYMENT_METHODS is a shared constant in types/receipt.ts that
                        utils/receiptPdf.ts also reads, so it is not translated in
                        place; the on-screen option label is resolved here instead. */}
                    <option value="bar">{t('rec.payment.bar')}</option>
                    <option value="uberweisung">{t('rec.payment.uberweisung')}</option>
                  </NativeSelect>
                </Field>
              </section>

              {hasFuelFigures(selectedCategory) && (
                <section className="grid gap-4">
                <h3 className="border-b border-line pb-1.5 text-[13px] font-semibold text-fg">
                  {t('rec.section.fuel')}
                </h3>
                  <p className="-mt-2 text-xs text-fg-subtle">{t('rec.section.fuelHint')}</p>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label={t('rec.litres')} required={!receipt}>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={details.litres}
                        onChange={e => setDetail('litres', e.target.value)}
                        placeholder="41,47"
                        className="tabular-nums"
                      />
                    </Field>
                    <Field label={t('rec.pricePerLitre')} required={!receipt}>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={details.pricePerLitre}
                        onChange={e => setDetail('pricePerLitre', e.target.value)}
                        placeholder="2,049"
                        className="tabular-nums"
                      />
                    </Field>
                    <Field label={t('rec.odometerKm')} hint={t('rec.odometerHint')} required={!receipt}>
                      <Input
                        type="text"
                        inputMode="numeric"
                        value={details.odometerKm}
                        onChange={e => setDetail('odometerKm', e.target.value)}
                        placeholder="123456"
                        className="tabular-nums"
                      />
                    </Field>
                    <Field label={t('rec.rangeKm')} hint={t('rec.rangeHint')}>
                      <Input
                        type="text"
                        inputMode="numeric"
                        value={details.rangeKm}
                        onChange={e => setDetail('rangeKm', e.target.value)}
                        placeholder="480"
                        className="tabular-nums"
                      />
                    </Field>
                  </div>
                </section>
              )}
            </form>
          </div>
        </SheetBody>

        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} disabled={scanState === 'scanning'}>
            {scanState === 'scanning' ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : <Save aria-hidden />}
            {scanState === 'scanning' ? t('rec.scanning') : t('common.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

export default ReceiptModal;
