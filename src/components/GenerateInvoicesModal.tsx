import { useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, Input, NativeSelect,
} from './ui';
import { fetchAllActiveSubscriptions, fetchInvoiceQuotes, fetchInvoicedCompanyIds } from '../lib/platformBillingClient';
import type { PlatformInvoiceQuote, PlatformSubscriptionRow } from '../lib/platformBilling';
import { invoiceDueDate } from '../utils/invoiceDueDate';

interface Props {
  onClose: () => void;
  onGenerated: () => void;
}

// Holds TranslationKeys: this list is module-level and t() is a hook value. These
// month names only label the on-screen picker and hint \u2014 no filename, no exported
// cell \u2014 so unlike document text they are translated.
const MONTH_KEYS: TranslationKey[] = [
  'bill.month.january', 'bill.month.february', 'bill.month.march', 'bill.month.april',
  'bill.month.may', 'bill.month.june', 'bill.month.july', 'bill.month.august',
  'bill.month.september', 'bill.month.october', 'bill.month.november', 'bill.month.december',
];

export default function GenerateInvoicesModal({ onClose, onGenerated }: Props) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const { t, tPlural } = useTranslation();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);

  /**
   * Every active subscription, read through the audited read model since
   * decision D14 — the page cannot pass them any more, because it holds one
   * server-side page of 100 and generating from a page would skip customers
   * silently, which is the defect slice 3.13b fixed in `manage-users/list`.
   * `null` means the list could not be read whole, and then nothing is
   * generated: a run over a partial list creates the wrong month.
   */
  const [activeSubs, setActiveSubs] = useState<PlatformSubscriptionRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchAllActiveSubscriptions()
      .catch(() => null)
      .then(rows => {
        if (cancelled) return;
        setActiveSubs(rows);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  /**
   * What each invoice of the chosen period costs, decided by the database
   * (`platform_invoice_quotes`, 20261015160000): the company's first invoice is
   * the price book's flat first-month figure, every later one the book per car.
   * Read again whenever the period changes, because "first" depends on it.
   * `null` means the amounts could not be read, and then nothing is generated.
   */
  const [quotes, setQuotes] = useState<Map<string, PlatformInvoiceQuote> | null>(null);
  const [quotesLoading, setQuotesLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setQuotesLoading(true);
    fetchInvoiceQuotes(month, year)
      .catch(() => null)
      .then(result => {
        if (cancelled) return;
        setQuotes(result);
        setQuotesLoading(false);
      });
    return () => { cancelled = true; };
  }, [month, year]);

  const companyLabel = (sub: PlatformSubscriptionRow) => sub.company_name || sub.company_id.slice(0, 8);

  const handleGenerate = async () => {
    if (!user || !activeSubs || !quotes) return;
    setGenerating(true);
    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    try {
      // Which companies already have an invoice for this period. The invoice
      // table is no longer readable across companies, so this is the audited
      // read model; null means the check could not be made, and then the
      // UNIQUE (company_id, invoice_month, invoice_year) decides, exactly as it
      // did when the direct query failed and returned nothing.
      const existingSet = (await fetchInvoicedCompanyIds(month, year)) ?? new Set<string>();

      for (const sub of activeSubs) {
        if (existingSet.has(sub.company_id)) {
          skipped.push(companyLabel(sub));
          continue;
        }

        // The amount is the database's quote for this period, not the
        // subscription's stored rate: a missing quote creates nothing.
        const quote = quotes.get(sub.id);
        if (!quote) {
          errors.push(t('bill.invoice.quoteFailed') + ' ' + companyLabel(sub));
          continue;
        }

        // Generate invoice number via RPC
        const { data: invNum } = await supabase.rpc('generate_invoice_number', { p_year: year });
        if (!invNum) {
          errors.push(t('bill.invoice.numberFailed', { company: companyLabel(sub) }));
          continue;
        }

        const dueDate = invoiceDueDate(year, month, sub.billing_day);

        const { error: insertErr } = await supabase
          .from('subscription_invoices')
          .insert({
            company_id: sub.company_id,
            subscription_id: sub.id,
            invoice_month: month,
            invoice_year: year,
            invoice_number: invNum,
            amount: quote.amountCents / 100,
            status: 'open',
            payment_method: 'cash',
            due_date: dueDate,
          });

        if (insertErr) {
          if (insertErr.code === '23505') {
            skipped.push(companyLabel(sub));
          } else {
            errors.push(`${companyLabel(sub)}: ${insertErr.message}`);
          }
        } else {
          created.push(companyLabel(sub));
        }
      }

      setResults({ created: created.length, skipped: skipped.length, errors });
      if (created.length > 0) {
        showToast('success', tPlural({ one: 'bill.invoice.createdCount.one', other: 'bill.invoice.createdCount.other' }, created.length));
        onGenerated();
      }
    } catch (err: any) {
      showToast('error', t('bill.errorWithMessage', { message: err.message || t('common.unknown') }));
    } finally {
      setGenerating(false);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the dialog's logic and is unchanged, bar the
  // `inputStyle` object, which was only look and is classes now. Everything
  // below only draws.

  const generateDisabled = generating || loading || quotesLoading || !quotes || !activeSubs || activeSubs.length === 0;

  return (
    <Dialog
      open
      onOpenChange={open => {
        // A run in progress is not interrupted: its result is shown in this dialog.
        if (!open && !generating) onClose();
      }}
    >
      <DialogContent className="max-w-md" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-brand-soft text-brand-text">
              <FileText aria-hidden className="size-5" />
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span>{t('bill.invoice.generateTitle')}</span>
              <span className="text-xs font-normal text-fg-subtle">
                {loading
                  ? t('common.loading')
                  : tPlural({ one: 'bill.invoice.activeSubs.one', other: 'bill.invoice.activeSubs.other' }, activeSubs?.length ?? 0)}
              </span>
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">{t('bill.invoice.generateTitle')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('common.month')}>
              <NativeSelect value={month} onChange={e => setMonth(+e.target.value)}>
                {MONTH_KEYS.map((key, i) => <option key={key} value={i + 1}>{t(key)}</option>)}
              </NativeSelect>
            </Field>
            <Field label={t('bill.field.year')}>
              <Input type="number" value={year} onChange={e => setYear(+e.target.value)} min={2024} max={2099} />
            </Field>
          </div>

          {/* A list that could not be read whole is not generated from: an
              invoice run over part of the customers is the wrong month, and an
              empty count would read as "no active subscriptions". */}
          {!loading && activeSubs === null ? (
            <Alert tone="critical" className="font-ui">{t('admin.read.failed')}</Alert>
          ) : (
            <div className="rounded-tile bg-sunken p-3 text-sm text-fg-muted">
              {t('bill.invoice.hintPeriodLead', { count: activeSubs?.length ?? 0 })}{' '}
              <strong>{t(MONTH_KEYS[month - 1])} {year}</strong>
              {t('bill.invoice.hintPeriodTail')}
            </div>
          )}

          {!loading && !quotesLoading && quotes === null ? (
            <Alert tone="critical" className="font-ui">{t('bill.invoice.quoteFailed')}</Alert>
          ) : (
            <p className="font-ui text-xs text-fg-muted">{t('bill.invoice.quoteHint')}</p>
          )}

          {results && (
            <Alert tone={results.errors.length > 0 ? 'critical' : 'positive'}>
              <div className="grid gap-1">
                <p className="text-positive">
                  {tPlural({ one: 'bill.invoice.createdCount.one', other: 'bill.invoice.createdCount.other' }, results.created)}
                </p>
                {results.skipped > 0 && <p className="text-fg-subtle">{t('bill.invoice.skippedCount', { count: results.skipped })}</p>}
                {results.errors.map((e, i) => <p key={i} className="text-critical">{e}</p>)}
              </div>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button type="button" onClick={handleGenerate} disabled={generateDisabled}>
            {generating
              ? <><Loader2 aria-hidden className="motion-safe:animate-spin" /> {t('bill.invoice.generating')}</>
              : <><FileText aria-hidden /> {t('bill.invoice.generate')}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
