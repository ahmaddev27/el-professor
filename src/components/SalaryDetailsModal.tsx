import React, { useState, useEffect, type FormEvent } from 'react';
import { X, Plus, CreditCard as Edit2, Trash2, DollarSign, AlertCircle, FileText, CheckSquare, Square, Building2, Banknote, LayoutDashboard, Zap, Lock, Eye, Ban } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { SalaryPayment, SalaryCalculation } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../contexts/PlanContext';
import { useToast } from '../contexts/ToastContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { format } from 'date-fns';
import SalaryPaymentModal from './SalaryPaymentModal';
import SalaryPaymentReceiptPreview from './SalaryPaymentReceiptPreview';
import GehaltsquittungModal from './GehaltsquittungModal';
import ConfirmationModal from './ConfirmationModal';
import {
  currentLoadState,
  loadReceiptForPreview,
  paymentRowActions,
  paymentRowStorno,
  stornoStep,
  voidReasonProblem,
  type ReceiptLoadState,
} from '../utils/salaryPaymentReceiptRow';
import { PAYMENT_WRITE_REFUSAL_KEYS, decidePaymentWrite } from '../utils/salaryPaymentWrite';
import {
  REFUSAL_MESSAGE_KEYS,
  confirmationBlock,
  findOverlappingSalary,
  outcomeIsUnknown,
  receiptScope,
  type ReceiptActionRefusal,
} from '../utils/salaryCashReceiptFlow';
import { derivePaymentStatus, remainingDue } from '../utils/salaryDue';
import { payrollRemaining, payrollSplit } from '../utils/payrollSplit';
import {
  loadReceiptById,
  voidReceipt,
  type SalaryCashReceipt,
  type SalaryCashReceiptWithDriver,
} from '../lib/salaryCashReceipts';
import { ReceiptAlert, useRefusalMessage } from './GehaltsquittungParts';
import { toCents } from '../utils/money';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  formatDate,
  formatEuroCents,
} from './ui';
import type { GehaltsquittungPreselect } from '../hooks/useGehaltsquittungFlow';
import { generateDriverSalaryPdf } from '../utils/driverSalaryPdf';
import DriverSalarySummaryCard from './DriverSalarySummaryCard';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

interface SalaryDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  salary: SalaryCalculation;
  onUpdate: () => void;
}

interface PayrollData {
  payroll_gross_amount: number | null;
  payroll_net_amount: number | null;
  tax_review_confirmed: boolean;
}

/** The columns the overlap refusal needs to name the other salary row. */
interface OverlappingSalaryRow {
  id: string;
  period_start: string;
  period_end: string;
  amount_due: number | string | null;
  netto_salary: number | string | null;
}

/**
 * The other row's due amount, so the refusal names a figure the user can match
 * on the salaries screen. COALESCE(netto_salary, amount_due, 0), the same base
 * salaryDueCents uses, and an unreadable value becomes "—" rather than throwing
 * inside a message about something else.
 */
function overlappingSalaryAmount(row: OverlappingSalaryRow): string {
  const due = row.netto_salary ?? row.amount_due ?? 0;
  try {
    return formatEuroCents(toCents(due));
  } catch {
    return '—';
  }
}

const SalaryDetailsModal: React.FC<SalaryDetailsModalProps> = ({
  isOpen,
  onClose,
  salary,
  onUpdate,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'details' | 'summary'>('details');
  const [payments, setPayments] = useState<SalaryPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingPayroll, setSavingPayroll] = useState(false);
  const [loadingWeekly, setLoadingWeekly] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<SalaryPayment | undefined>();
  const [paymentToDelete, setPaymentToDelete] = useState<SalaryPayment | null>(null);
  /** The Gehaltsquittung shown over this screen; null while none is open. */
  const [receiptPreviewId, setReceiptPreviewId] = useState<string | null>(null);
  /**
   * The Gehaltsquittung this screen is about to void; null while none is.
   *
   * Voiding is the only way a payment written by confirm_salary_cash_payment
   * leaves the salary, and it is one RPC: the receipt is marked voided with its
   * reason, the payment row is deleted, and the amount is booked back into the
   * till on the day of the void. The dialog below asks for that reason.
   */
  const [stornoReceiptId, setStornoReceiptId] = useState<string | null>(null);
  /** The cash payment handed to the Gehaltsquittung flow; null while none is being issued. */
  const [receiptDraft, setReceiptDraft] = useState<GehaltsquittungPreselect | null>(null);
  /**
   * Another salary row of this driver whose period overlaps this one, or null.
   *
   * `confirm_salary_cash_payment` refuses such a salary (`overlapping_salary`),
   * and since a cash payment is now always a Gehaltsquittung that refusal
   * reaches the payment form. The owner's rule, 17.09.2026: he merges the two
   * rows by hand and the system keeps refusing until he has — so the row is
   * looked up here to be *named* in the refusal, not to route around it. One
   * staging company holds 16 such pairs and another 25 rows in one company, so
   * "these rows overlap" without saying which is not something anyone can act
   * on.
   */
  const [overlappingSalary, setOverlappingSalary] = useState<OverlappingSalaryRow | null>(null);
  const [payrollData, setPayrollData] = useState<PayrollData>({
    payroll_gross_amount: null,
    payroll_net_amount: null,
    tax_review_confirmed: false,
  });

  const { showToast } = useToast();
  const { user, companyId: ownCompanyId, can: rolePermits } = useAuth();
  const navigate = useNavigate();
  const { can: planIncludes } = usePlan();
  const { effectiveCompanyId: companyId, isViewingAsCompany } = useSuperAdmin();
  const { settings } = useCompanySettings();

  // This screen reads the effective company, so platform staff who have entered
  // a customer see that customer's payment rows. A Gehaltsquittung behind one of
  // them loads with the caller's own company, so the preview is offered only
  // inside it — see paymentRowActions.
  const receiptsScope = receiptScope({ companyId: ownCompanyId, effectiveCompanyId: companyId, isViewingAsCompany });

  // The system-calculated total salary
  const calculatedSalaryTotal = salary.netto_salary ?? salary.amount_due ?? 0;

  /**
   * The payroll split: cash = total − Brutto, bank = Netto, payout = cash + bank.
   *
   * `payrollSplit` states no cash figure while the Brutto is unknown. Before it,
   * `payrollGross = gross ?? 0` made a row with only the Steuerberater's Netto
   * report the *whole* salary as cash and the Netto on top — a payout larger
   * than the salary. 0 of 53 staging rows are in that state, so no document
   * already issued changes.
   */
  const split = payrollSplit({
    total: calculatedSalaryTotal,
    gross: payrollData.payroll_gross_amount,
    net: payrollData.payroll_net_amount,
  });

  // Payment tracking: the status follows the payments against the base, and is
  // never read off `salaries.payment_status` — utils/salaryDue.ts holds the rule.
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const remainingBalance = remainingDue(calculatedSalaryTotal, totalPaid);
  const paymentStatus = derivePaymentStatus(calculatedSalaryTotal, totalPaid);

  useEffect(() => {
    if (isOpen && salary.salary_id) {
      fetchPayments();
      fetchPayrollData();
      fetchOverlappingSalary();
    } else if (isOpen && !salary.salary_id) {
      ensureSalaryExists();
    }
  }, [isOpen, salary.salary_id]);

  /**
   * The other salary row of this driver whose period overlaps this one, so the
   * cash refusal can name it. A failed read leaves it null: the database
   * refuses the payment either way, and inventing an overlap would block a
   * payment that is fine.
   */
  const fetchOverlappingSalary = async () => {
    setOverlappingSalary(null);
    if (!salary.salary_id || !salary.period_start || !salary.period_end || !companyId) return;
    const { data, error } = await supabase
      .from('salaries')
      .select('id, period_start, period_end, amount_due, netto_salary')
      .eq('company_id', companyId)
      .eq('driver_id', salary.driver_id);
    if (error || !data) return;
    setOverlappingSalary(
      findOverlappingSalary(
        { id: salary.salary_id, period_start: salary.period_start, period_end: salary.period_end },
        data as OverlappingSalaryRow[],
      ),
    );
  };

  const ensureSalaryExists = async () => {
    if (salary.salary_id) return;
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) throw new Error(t('sal.notSignedIn'));
      if (!salary.period_start || !salary.period_end) throw new Error(t('sal.periodMissing'));

      const { data: existing } = await supabase
        .from('salaries')
        .select('id')
        .eq('driver_id', salary.driver_id)
        .eq('period_start', salary.period_start)
        .eq('period_end', salary.period_end)
        .maybeSingle();

      if (existing) {
        salary.salary_id = existing.id;
        await onUpdate();
        return;
      }

      const { data, error } = await supabase.from('salaries').insert({
        driver_id: salary.driver_id,
        period_start: salary.period_start,
        period_end: salary.period_end,
        calc_revenue: salary.revenue,
        calc_tips: salary.tips,
        amount_due: salary.amount_due,
        status: 'unpaid',
        created_by: authUser.id,
        company_id: companyId,
      }).select().single();

      if (error) throw error;
      salary.salary_id = data.id;
      await onUpdate();
    } catch (error: any) {
      console.error('Error creating salary record:', error);
      showToast('error', t('sal.error.createSalary'));
    }
  };

  const fetchPayments = async () => {
    if (!salary.salary_id) return;
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('salary_payments')
        .select('*')
        .eq('salary_id', salary.salary_id)
        .order('payment_date', { ascending: false });
      if (error) throw error;
      setPayments(data || []);
    } catch {
      showToast('error', t('sal.error.loadPayments'));
    } finally {
      setLoading(false);
    }
  };

  const fetchPayrollData = async () => {
    if (!salary.salary_id) return;
    const { data } = await supabase
      .from('salaries')
      .select('payroll_gross_amount,payroll_net_amount,tax_review_confirmed')
      .eq('id', salary.salary_id)
      .maybeSingle();

    if (data) {
      setPayrollData({
        payroll_gross_amount: data.payroll_gross_amount ?? null,
        payroll_net_amount: data.payroll_net_amount ?? null,
        tax_review_confirmed: data.tax_review_confirmed ?? false,
      });
    }
  };

  const savePayrollData = async () => {
    if (!salary.salary_id) return;
    setSavingPayroll(true);
    try {
      // Compute and persist the derived values alongside the inputs
      const grossVal = payrollData.payroll_gross_amount;
      const netVal = payrollData.payroll_net_amount;
      const computedCash = grossVal != null ? calculatedSalaryTotal - grossVal : null;
      const computedBank = netVal;
      const computedTotal = computedCash != null && computedBank != null ? computedCash + computedBank : null;

      const updates: Record<string, unknown> = {
        payroll_gross_amount: grossVal,
        payroll_net_amount: netVal,
        cash_salary_amount: computedCash,
        bank_salary_amount: computedBank,
        total_net_payout: computedTotal,
        tax_review_confirmed: payrollData.tax_review_confirmed,
      };

      if (payrollData.tax_review_confirmed) {
        updates.tax_review_confirmed_at = new Date().toISOString();
        updates.tax_review_confirmed_by = user?.id ?? null;
      }

      const { error } = await supabase
        .from('salaries')
        .update(updates)
        .eq('id', salary.salary_id);

      if (error) throw error;
      showToast('success', t('sal.payroll.saved'));
    } catch {
      showToast('error', t('sal.error.save'));
    } finally {
      setSavingPayroll(false);
    }
  };

  const handleWeeklyCashPayment = async () => {
    if (!salary.period_start || !salary.period_end) {
      showToast('warning', t('sal.weekly.selectFirst'));
      return;
    }

    setLoadingWeekly(true);
    try {
      // Derive year/month from period_start (business month: month of the period start)
      const periodDate = new Date(salary.period_start);
      const year = periodDate.getFullYear();
      const month = periodDate.getMonth() + 1; // 1-based

      // Fetch weekly Abrechnung for this driver and month
      const { data: weeklyRows, error: rpcErr } = await supabase.rpc('get_weekly_abrechnung', {
        p_year: year,
        p_month: month,
      });

      if (rpcErr) throw new Error(rpcErr.message);

      // Filter rows for this driver only
      const driverRows = (weeklyRows || []).filter(
        (r: { driver_name: string }) => r.driver_name === salary.driver_name
      );

      if (driverRows.length === 0) {
        showToast('warning', t('sal.weekly.notFound'));
        return;
      }

      // Pick the row with the highest week_number (= last week of the month)
      const lastWeekRow = driverRows.reduce(
        (prev: { week_number: number }, cur: { week_number: number }) =>
          cur.week_number > prev.week_number ? cur : prev
      );

      const difference: number = Number(lastWeekRow.bar_zuruck ?? 0);
      const weekNumber: number = lastWeekRow.week_number;

      if (difference < 0.01) {
        if (difference < -0.01) {
          showToast('warning', t('sal.weekly.noCashOpenDiff'));
        } else {
          showToast('info', t('sal.weekly.noPositiveDiff'));
        }
        return;
      }

      // Build a stable source reference: driverId_year_month_weekNumber
      const sourceReference = `${salary.driver_id}_${year}_${month}_${weekNumber}`;

      // Ensure salary record exists first
      if (!salary.salary_id) {
        await ensureSalaryExists();
        // After ensureSalaryExists salary.salary_id may be set — wait briefly for state update
        await new Promise(r => setTimeout(r, 100));
      }

      const salaryId = salary.salary_id;
      if (!salaryId) {
        showToast('error', t('sal.error.createPayroll'));
        return;
      }

      // Duplicate check: same salary + source_reference
      const { data: existing } = await supabase
        .from('salary_payments')
        .select('id')
        .eq('salary_id', salaryId)
        .eq('source_type', 'weekly_cash_difference')
        .eq('source_reference', sourceReference)
        .maybeSingle();

      if (existing) {
        showToast('warning', t('sal.weekly.alreadyImported'));
        return;
      }

      // Determine the week date range using the RPC result week_number + business calendar
      // We use period_end as the payment_date (last day of the week or period)
      // The last week's end date is the last day of the period
      const paymentDate = salary.period_end;

      const { data: authData } = await supabase.auth.getUser();
      const userId = authData.user?.id;
      if (!userId) throw new Error(t('sal.notSignedIn'));

      // "Bar zurück" is stored as cash but never left the till: it is money the
      // driver kept out of a weekly settlement. It stays a plain row — no
      // receipt, no cash_movements — and the rule is asked by origin here so a
      // change to it fails loudly instead of booking a payout that never
      // happened.
      const weekly = decidePaymentWrite({ origin: 'weekly_cash_difference' });
      if (weekly.kind !== 'insert') throw new Error(t('sal.weekly.errorCreate'));

      const { error: insertErr } = await supabase.from('salary_payments').insert({
        salary_id: salaryId,
        payment_type: 'cash',
        amount: Math.round(difference * 100) / 100,
        payment_date: paymentDate,
        // `description` and `payment_category` are persisted to salary_payments and
        // read back as stored data, so they stay German in both languages.
        description: 'Automatisch aus letzter Wochenabrechnung übernommen',
        payment_category: 'Bargehalt',
        source_type: 'weekly_cash_difference',
        source_reference: sourceReference,
        week_start: salary.period_start,
        week_end: salary.period_end,
        created_by: userId,
        company_id: companyId,
      });

      if (insertErr) {
        // Postgres unique constraint violation
        if (insertErr.code === '23505') {
          showToast('warning', t('sal.weekly.alreadyImported'));
          return;
        }
        throw new Error(insertErr.message);
      }

      await fetchPayments();
      await onUpdate();
      showToast('success', t('sal.weekly.created', { amount: difference.toLocaleString('de-DE', { minimumFractionDigits: 2 }) }));
    } catch (err: any) {
      showToast('error', err.message || t('sal.weekly.errorCreate'));
    } finally {
      setLoadingWeekly(false);
    }
  };

  /**
   * Why a cash payment cannot be recorded for this salary at all, ready to
   * show; null when it can.
   *
   * Every cash payment is now a Gehaltsquittung, so the Gehaltsquittung's own
   * conditions decide, and they are answered **before** the payment form
   * closes: the form is where the user can still choose a bank transfer
   * instead. Computed once and used twice — for the notice beside the type
   * select and as the guard in startGehaltsquittung — so the sentence shown and
   * the reason the write is refused cannot differ.
   *
   * The order is the order in which they stop being fixable by this user:
   * scope and role, then the plan, then the overlapping salary rows the owner
   * merges by hand.
   */
  const cashBlockedMessage = ((): string | null => {
    const blocked = confirmationBlock(receiptsScope, rolePermits('salaries', 'edit'));
    if (blocked) return t(REFUSAL_MESSAGE_KEYS[blocked]);
    // The row's own preview button asks the same feature (paymentRowActions):
    // without it a company could create receipts it can neither preview nor
    // void, since plan_features is writable and could put gehaelter below
    // dokumente.
    if (!planIncludes('dokumente')) return t('sal.payment.cashNeedsDokumente');
    if (overlappingSalary) {
      return t('sal.payment.cashBlockedOverlap', {
        period: `${format(new Date(overlappingSalary.period_start), 'dd.MM.yyyy')} – ${format(new Date(overlappingSalary.period_end), 'dd.MM.yyyy')}`,
        amount: overlappingSalaryAmount(overlappingSalary),
      });
    }
    return null;
  })();

  /**
   * Hands a cash payment the user just entered to the Gehaltsquittung flow, or
   * names why it cannot go there. Nothing is written here: the receipt, the
   * salary_payments row and the outgoing cash_movements row are one transaction
   * inside confirm_salary_cash_payment, and the browser has no write on any of
   * the three.
   *
   * The refusal is thrown so the payment form shows it in its own error box.
   * The form already disables its submit for the same reasons; this is the
   * second wall, because the form is told what to show and this is what acts.
   */
  const startGehaltsquittung = (paymentData: Pick<SalaryPayment, 'amount' | 'payment_date'>) => {
    if (cashBlockedMessage) throw new Error(cashBlockedMessage);
    if (!salary.salary_id) throw new Error(t('gq.refusal.salaryNotFound'));

    // toCents refuses anything that is not a finite decimal amount rather than
    // rounding it to a silent 0, so the form says so instead of throwing.
    let amountCents: number;
    try {
      amountCents = toCents(paymentData.amount);
    } catch {
      throw new Error(t('gq.refusal.invalidAmount'));
    }

    setIsPaymentModalOpen(false);
    setSelectedPayment(undefined);
    setReceiptDraft({
      driverId: salary.driver_id,
      salaryId: salary.salary_id,
      amountCents,
      paymentDate: paymentData.payment_date,
    });
  };

  const handleSavePayment = async (paymentData: Omit<SalaryPayment, 'id' | 'created_by' | 'created_at' | 'updated_at'>) => {
    // Owner decision, 17.09.2026: a cash payment added here is a Gehaltsquittung.
    // The rule is keyed on this deliberate action and on the stored row, never
    // on payment_type alone — the weekly "Bar zurück" is also cash and must not
    // book a payout from the till. See utils/salaryPaymentWrite.ts.
    const decision = decidePaymentWrite({
      origin: selectedPayment ? 'edit' : 'add',
      paymentType: paymentData.payment_type,
      amount: paymentData.amount,
      existing: selectedPayment
        ? {
            payment_type: selectedPayment.payment_type,
            source_type: selectedPayment.source_type ?? null,
            amount: selectedPayment.amount,
          }
        : null,
    });

    if (decision.kind === 'refused') throw new Error(t(PAYMENT_WRITE_REFUSAL_KEYS[decision.refusal]));
    if (decision.kind === 'gehaltsquittung') {
      startGehaltsquittung(paymentData);
      return;
    }

    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) throw new Error(t('sal.notSignedIn'));

    // Each write is reached by naming its decision, and anything else stops.
    // The fallthrough used to be the plain INSERT, so an `update` that had lost
    // its row — or a kind added later — would have landed in exactly the write
    // this path exists to keep cash payments out of.
    if (decision.kind === 'update') {
      if (!selectedPayment) throw new Error(t('sal.payment.rowNotFound'));
      const { error } = await supabase
        .from('salary_payments')
        .update({
          payment_type: paymentData.payment_type,
          amount: paymentData.amount,
          payment_date: paymentData.payment_date,
          description: paymentData.description,
        })
        .eq('id', selectedPayment.id);
      if (error) throw error;
      showToast('success', t('sal.payment.updated'));
    } else if (decision.kind === 'insert') {
      const { error } = await supabase
        .from('salary_payments')
        .insert({ ...paymentData, created_by: authUser.id, company_id: companyId });
      if (error) throw error;
      showToast('success', t('sal.payment.added'));
    } else {
      throw new Error(t('sal.payment.errorSave'));
    }

    await fetchPayments();
    setIsPaymentModalOpen(false);
    setSelectedPayment(undefined);
    await onUpdate();
  };

  /**
   * The screen after a Storno. `void_salary_cash_receipt` deleted the payment
   * inside its own transaction and booked the cash back, so this row disappears
   * and the salary's paid figures change: both are re-read from the database
   * rather than adjusted here.
   *
   * Also called when the outcome is unknown — no answer, or one that names no
   * reason — because the void may have gone through. Then nothing is claimed;
   * the list is simply re-read, and the dialog keeps showing what it knows.
   */
  const reloadAfterStorno = async () => {
    await fetchPayments();
    await onUpdate();
  };

  const handleDeletePayment = async () => {
    if (!paymentToDelete) return;
    try {
      const { error } = await supabase.from('salary_payments').delete().eq('id', paymentToDelete.id);
      if (error) throw error;
      showToast('success', t('sal.payment.deleted'));
      await fetchPayments();
      await onUpdate();
    } catch (error: any) {
      showToast('error', error.message || t('common.errorDelete'));
    } finally {
      setPaymentToDelete(null);
    }
  };

  const handleExportPdf = () => {
    // Only figures cross into the PDF here; its own labels live in driverSalaryPdf.ts
    // and stay German because the document goes to the Steuerberater.
    generateDriverSalaryPdf({
      salary,
      settings,
      payrollGrossAmount: payrollData.payroll_gross_amount,
      payrollNetAmount: payrollData.payroll_net_amount,
      // Only a split whose Brutto is known carries figures into the PDF.
      cashSalaryAmount: split.cash ?? undefined,
      bankSalaryAmount: split.established ? split.bank : undefined,
      totalNetPayout: split.payout ?? undefined,
    });
  };

  // `status` is the derived payment status; only the badge text is translated.
  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'paid':
        return <span style={{ background: 'var(--success-subtle)', color: 'var(--success)', borderRadius: '9999px', padding: '0.25rem 0.75rem', fontSize: '0.875rem', fontWeight: 500 }}>{t('sal.status.fullyPaid')}</span>;
      case 'partially_paid':
        return <span style={{ background: 'var(--warning-subtle)', color: 'var(--warning)', borderRadius: '9999px', padding: '0.25rem 0.75rem', fontSize: '0.875rem', fontWeight: 500 }}>{t('sal.status.partiallyPaid')}</span>;
      default:
        return <span style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', borderRadius: '9999px', padding: '0.25rem 0.75rem', fontSize: '0.875rem', fontWeight: 500 }}>{t('sal.status.unpaid')}</span>;
    }
  };

  const handleClose = async () => {
    await onUpdate();
    onClose();
  };

  if (!isOpen) return null;

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: '0.375rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.375rem 0.625rem',
    outline: 'none',
    width: '100%',
  };

  const readonlyRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 0',
    borderBottom: '1px solid var(--border)',
  };

  const fmtEur = (n: number) =>
    n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div style={{ background: 'var(--bg-surface)', borderRadius: '0.5rem', boxShadow: 'var(--shadow-lg)' }} className="w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">

          {/* Header */}
          <div style={{ borderBottom: '1px solid var(--border)' }} className="px-6 pt-6 pb-0">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 style={{ color: 'var(--text-primary)' }} className="text-2xl font-bold">
                  {t('sal.details.title', { name: salary.driver_name })}
                </h2>
                <p style={{ color: 'var(--text-secondary)' }} className="text-sm mt-1">
                  {salary.period_start && salary.period_end
                    ? `${format(new Date(salary.period_start), 'dd.MM.yyyy')} – ${format(new Date(salary.period_end), 'dd.MM.yyyy')}`
                    : format(new Date(salary.paid_at || new Date()), 'dd.MM.yyyy')}
                </p>
              </div>
              <button
                onClick={handleClose}
                style={{ color: 'var(--text-tertiary)', marginTop: '0.25rem' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
              >
                <X size={24} />
              </button>
            </div>

            {/* Tab bar */}
            <div className="flex gap-1" style={{ marginBottom: '-1px' }}>
              {([
                { key: 'details', label: t('sal.tab.details'), icon: <DollarSign size={15} /> },
                { key: 'summary', label: t('common.summary'), icon: <LayoutDashboard size={15} /> },
              ] as const).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors"
                  style={{
                    background: activeTab === tab.key ? 'var(--bg-surface)' : 'transparent',
                    color: activeTab === tab.key ? 'var(--accent)' : 'var(--text-tertiary)',
                    border: activeTab === tab.key ? '1px solid var(--border)' : '1px solid transparent',
                    borderBottom: activeTab === tab.key ? '1px solid var(--bg-surface)' : '1px solid transparent',
                    cursor: 'pointer',
                  }}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-6 space-y-6 overflow-y-auto flex-1">

            {/* ── Summary tab ── */}
            {activeTab === 'summary' && (
              <DriverSalarySummaryCard
                driverName={salary.driver_name}
                periodStart={salary.period_start || new Date().toISOString().slice(0, 10)}
                periodEnd={salary.period_end || new Date().toISOString().slice(0, 10)}
                totalRevenue={salary.revenue}
                salaryRatio={salary.salary_ratio}
                driverPartAmount={salary.revenue_share}
                tips={salary.tips}
                alreadyPaidSalary={totalPaid}
                remainingSalary={remainingBalance}
                brutto={payrollData.payroll_gross_amount}
                nettoBank={payrollData.payroll_net_amount}
                cashSalary={split.cash}
                totalNetPayout={split.payout}
                remainingPayout={payrollRemaining(split, totalPaid)}
                companyName={settings?.company_name}
              />
            )}

            {/* ── Details tab ── */}
            {activeTab === 'details' && (<>

            {/* KPI summary cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div style={{ background: 'var(--accent-subtle)', borderRadius: '0.5rem', padding: '1rem' }}>
                <div style={{ color: 'var(--accent)', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                  {t('sal.calculatedDriverSalary')}
                  {salary.netto_salary && salary.netto_salary !== salary.amount_due && (
                    <span style={{ fontSize: '0.75rem', opacity: 0.8 }}> {t('sal.adjustedSuffix')}</span>
                  )}
                </div>
                <div style={{ color: 'var(--text-primary)', fontSize: '1.5rem', fontWeight: 700 }}>
                  {fmtEur(calculatedSalaryTotal)}
                </div>
              </div>

              <div style={{ background: 'var(--success-subtle)', borderRadius: '0.5rem', padding: '1rem' }}>
                <div style={{ color: 'var(--success)', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>{t('sal.alreadyPaid')}</div>
                <div style={{ color: 'var(--text-primary)', fontSize: '1.5rem', fontWeight: 700 }}>
                  {fmtEur(totalPaid)}
                </div>
              </div>

              <div style={{ background: remainingBalance > 0 ? 'var(--danger-subtle)' : 'var(--bg-subtle)', borderRadius: '0.5rem', padding: '1rem' }}>
                <div style={{ color: remainingBalance > 0 ? 'var(--danger)' : 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                  {t('sal.remaining')}
                </div>
                <div style={{ color: 'var(--text-primary)', fontSize: '1.5rem', fontWeight: 700 }}>
                  {fmtEur(remainingBalance)}
                </div>
              </div>
            </div>

            {/* ——— Lohnabrechnung & Auszahlung ——— */}
            <div style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', overflow: 'hidden' }}>
              <div style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', padding: '0.875rem 1.25rem' }} className="flex items-center justify-between">
                <h3 style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t('sal.payroll.sectionTitle')}</h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{t('sal.payroll.internalOnly')}</span>
              </div>

              <div className="p-5 space-y-5">

                {/* Read-only: system total */}
                <div style={readonlyRowStyle}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{t('sal.calculatedDriverSalary')}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{fmtEur(calculatedSalaryTotal)}</span>
                </div>

                {/* Editable inputs */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('sal.payroll.grossLabel')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0,00"
                      value={payrollData.payroll_gross_amount ?? ''}
                      onChange={e => setPayrollData(prev => ({
                        ...prev,
                        payroll_gross_amount: e.target.value === '' ? null : Number(e.target.value),
                      }))}
                      style={inputStyle}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                      {t('sal.payroll.grossHint')}
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('sal.payroll.netLabel')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0,00"
                      value={payrollData.payroll_net_amount ?? ''}
                      onChange={e => setPayrollData(prev => ({
                        ...prev,
                        payroll_net_amount: e.target.value === '' ? null : Number(e.target.value),
                      }))}
                      style={inputStyle}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                      {t('sal.payroll.netHint')}
                    </p>
                  </div>
                </div>

                {/* Warning: gross > calculated total */}
                {split.grossExceedsTotal && (
                  <div style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)', borderRadius: '0.375rem', padding: '0.625rem 0.875rem' }} className="flex items-center gap-2">
                    <AlertCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.875rem', color: 'var(--danger)' }}>
                      {t('sal.payroll.grossExceedsWarning')}
                    </span>
                  </div>
                )}

                {/* The Brutto is what the cash remainder is measured against, so
                    without it the payout is not computed at all. Saying so is the
                    whole change: the block used to show the full salary as cash. */}
                {split.problem === 'gross_missing' && (
                  <div
                    style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)', color: 'var(--warning)' }}
                    className="flex items-center gap-2 rounded-md px-3.5 py-2.5"
                  >
                    {/* The colour is set once here and inherited: lucide draws in
                        currentColor, so the icon and the sentence need none of
                        their own. Three inline styles become one, which is what
                        keeps this file under the style ratchet. */}
                    <AlertCircle size={16} className="shrink-0" />
                    <span className="text-sm">
                      {t('sal.payroll.grossLabel')} — {t('sal.summary.grossNotEntered')}
                    </span>
                  </div>
                )}

                {/* Computed breakdown — shown once the split is established */}
                {split.established && (
                  <div style={{ background: 'var(--bg-subtle)', borderRadius: '0.5rem', padding: '1rem', border: '1px solid var(--border)' }} className="space-y-0">
                    <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {t('sal.payroll.computedPayout')}
                    </p>

                    {/* Bargehalt */}
                    <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <Banknote size={15} style={{ color: 'var(--success)' }} />
                        <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{t('sal.payroll.cashSalary')}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          ({fmtEur(calculatedSalaryTotal)} − {fmtEur(split.gross)})
                        </span>
                      </div>
                      <span style={{
                        fontWeight: 700,
                        color: split.cashIsNegative ? 'var(--danger)' : 'var(--text-primary)',
                      }}>
                        {fmtEur(split.cash)}
                        {split.cashIsNegative && <span className="ml-1 text-xs">⚠</span>}
                      </span>
                    </div>

                    {/* Bankgehalt */}
                    <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <Building2 size={15} style={{ color: 'var(--accent)' }} />
                        <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{t('sal.payroll.bankSalary')}</span>
                      </div>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{fmtEur(split.bank)}</span>
                    </div>

                    {/* Total net payout */}
                    <div className="flex items-center justify-between pt-2">
                      <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {t('sal.payroll.totalNetPayout')}
                      </span>
                      <span style={{
                        fontSize: '1.125rem',
                        fontWeight: 700,
                        color: split.cashIsNegative ? 'var(--warning)' : 'var(--success)',
                      }}>
                        {fmtEur(split.payout)}
                        {split.cashIsNegative && (
                          <span style={{ fontSize: '0.75rem', color: 'var(--warning)', marginLeft: '0.5rem', fontWeight: 400 }}>
                            {t('sal.payroll.cashNegative')}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                )}

                {/* Tax confirmation */}
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setPayrollData(prev => ({ ...prev, tax_review_confirmed: !prev.tax_review_confirmed }))}
                    className="flex items-center gap-2 text-sm"
                    style={{ color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    {payrollData.tax_review_confirmed
                      ? <CheckSquare size={16} style={{ color: 'var(--success)' }} />
                      : <Square size={16} style={{ color: 'var(--text-tertiary)' }} />}
                    {t('sal.payroll.taxReviewed')}
                  </button>
                </div>

                <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                  {t('sal.payroll.taxDisclaimer')}
                </p>

                <div className="flex justify-end">
                  <button
                    onClick={savePayrollData}
                    disabled={savingPayroll}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
                    style={{
                      background: 'var(--accent)',
                      color: 'var(--text-inverse)',
                      border: 'none',
                      cursor: savingPayroll ? 'not-allowed' : 'pointer',
                      opacity: savingPayroll ? 0.7 : 1,
                    }}
                    onMouseEnter={e => { if (!savingPayroll) e.currentTarget.style.background = 'var(--accent-hover)'; }}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
                  >
                    {savingPayroll ? t('common.saving') : t('sal.payroll.save')}
                  </button>
                </div>
              </div>
            </div>

            {/* Payment status + add buttons */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 style={{ color: 'var(--text-primary)' }} className="text-lg font-semibold">{t('sal.paymentStatus')}</h3>
                <div className="mt-2">{getStatusBadge(paymentStatus)}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleWeeklyCashPayment}
                  disabled={loadingWeekly}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
                  style={{
                    background: 'var(--success-subtle)',
                    color: 'var(--success)',
                    border: '1px solid var(--success)',
                    cursor: loadingWeekly ? 'not-allowed' : 'pointer',
                    opacity: loadingWeekly ? 0.7 : 1,
                  }}
                  onMouseEnter={e => { if (!loadingWeekly) { e.currentTarget.style.background = 'var(--success-solid)'; e.currentTarget.style.color = '#fff'; } }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--success-subtle)'; e.currentTarget.style.color = 'var(--success)'; }}
                  title={t('sal.weekly.buttonTitle')}
                >
                  <Zap size={16} />
                  <span>{t('sal.weekly.button')}</span>
                </button>
                <button
                  onClick={() => { setSelectedPayment(undefined); setIsPaymentModalOpen(true); }}
                  disabled={remainingBalance <= 0}
                  style={{ background: 'var(--accent)', color: 'var(--text-inverse)', borderRadius: '0.5rem', padding: '0.5rem 1rem', border: 'none' }}
                  onMouseEnter={e => { if (remainingBalance > 0) e.currentTarget.style.background = 'var(--accent-hover)'; }}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
                  className="flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={20} />
                  <span>{t('sal.payment.add')}</span>
                </button>
              </div>
            </div>

            {/* Payment history */}
            <div>
              <h3 style={{ color: 'var(--text-primary)' }} className="text-lg font-semibold mb-4">{t('sal.paymentHistory')}</h3>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div style={{ borderColor: 'var(--accent)' }} className="animate-spin rounded-full h-8 w-8 border-b-2"></div>
                </div>
              ) : payments.length === 0 ? (
                <div style={{ color: 'var(--text-tertiary)' }} className="text-center py-8">{t('sal.noPayments')}</div>
              ) : (
                <div style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', overflow: 'hidden' }}>
                  <table className="w-full">
                    <thead style={{ background: 'var(--bg-subtle)' }}>
                      <tr>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 600 }}>{t('common.date')}</th>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 600 }}>{t('sal.payment.type')}</th>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.875rem', fontWeight: 600 }}>{t('common.amount')}</th>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 600 }}>{t('common.description')}</th>
                        <th style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.875rem', fontWeight: 600 }}>{t('sal.col.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((payment, idx) => {
                        const rowActions = paymentRowActions(payment, {
                          planIncludesDokumente: planIncludes('dokumente'),
                          scope: receiptsScope,
                        });
                        // The Storno is the row's only way out of a Gehaltsquittung
                        // payment, and it asks what the RPC asks: the caller's own
                        // company (never a platform support session) and edit rights
                        // on salaries. It is not gated on the plan — see
                        // paymentRowStorno.
                        const storno = paymentRowStorno(payment, {
                          scope: receiptsScope,
                          mayEditSalaries: rolePermits('salaries', 'edit'),
                        });
                        // Why the row cannot be voided belongs on the lock itself,
                        // next to where the button would be, rather than inside a
                        // dialog that opens only to refuse.
                        const lockedLabel =
                          storno.kind === 'blocked'
                            ? `${t('sal.payment.receiptLocked')} ${t(REFUSAL_MESSAGE_KEYS[storno.refusal])}`
                            : t('sal.payment.receiptLocked');
                        return (
                        <tr
                          key={payment.id}
                          style={{ borderTop: idx > 0 ? '1px solid var(--border)' : undefined }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <td style={{ color: 'var(--text-primary)', padding: '0.75rem 1rem', fontSize: '0.875rem' }}>
                            {format(new Date(payment.payment_date), 'dd.MM.yyyy')}
                          </td>
                          <td style={{ padding: '0.75rem 1rem', fontSize: '0.875rem' }}>
                            <div className="flex flex-col gap-1">
                              <span style={{
                                background: payment.payment_type === 'cash' ? 'var(--success-subtle)' : 'var(--accent-subtle)',
                                color: payment.payment_type === 'cash' ? 'var(--success)' : 'var(--accent)',
                                borderRadius: '0.25rem',
                                padding: '0.125rem 0.5rem',
                                fontSize: '0.75rem',
                                fontWeight: 500,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                width: 'fit-content',
                              }}>
                                {payment.payment_type === 'cash'
                                  ? <><Banknote size={12} />{t('sal.payment.cashBadge')}</>
                                  : <><Building2 size={12} />{t('sal.payment.bankBadge')}</>}
                              </span>
                              {payment.source_type === 'weekly_cash_difference' && (
                                <span style={{
                                  background: 'var(--warning-subtle)',
                                  color: 'var(--warning)',
                                  borderRadius: '0.25rem',
                                  padding: '0.125rem 0.375rem',
                                  fontSize: '0.6875rem',
                                  fontWeight: 500,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  width: 'fit-content',
                                }}>
                                  <Zap size={10} />{t('sal.weekly.badge')}
                                </span>
                              )}
                              {payment.source_type === 'gehaltsquittung' && (
                                <span style={{
                                  background: 'var(--bg-muted)',
                                  color: 'var(--text-secondary)',
                                  borderRadius: '0.25rem',
                                  padding: '0.125rem 0.375rem',
                                  fontSize: '0.6875rem',
                                  fontWeight: 500,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  width: 'fit-content',
                                }}>
                                  <Lock size={10} />{t('sal.payment.receiptBadge')}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ color: 'var(--text-primary)', padding: '0.75rem 1rem', fontSize: '0.875rem', textAlign: 'right', fontWeight: 600 }}>
                            {Number(payment.amount).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          </td>
                          <td style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem', fontSize: '0.875rem' }}>
                            {payment.description || '-'}
                          </td>
                          <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                            {rowActions.kind === 'receipt' ? (
                              // Written by confirm_salary_cash_payment; a trigger refuses any edit or
                              // delete, so the row changes only by voiding its receipt. The preview
                              // shows the stored receipt in place, and the Storno beside it runs the
                              // one RPC that removes the payment, books the cash back and keeps the
                              // receipt on record as voided.
                              <div className="flex items-center justify-end gap-2">
                                <span
                                  role="img"
                                  aria-label={lockedLabel}
                                  title={lockedLabel}
                                  style={{ color: 'var(--text-tertiary)', display: 'inline-flex' }}
                                >
                                  <Lock size={16} />
                                </span>
                                {rowActions.preview && (
                                  <button
                                    type="button"
                                    onClick={() => setReceiptPreviewId(rowActions.receiptId)}
                                    aria-label={t('sal.payment.previewReceiptAria', {
                                      date: format(new Date(payment.payment_date), 'dd.MM.yyyy'),
                                    })}
                                    style={{ color: 'var(--accent)', borderRadius: '0.25rem', padding: '0.25rem 0.375rem', fontSize: '0.8125rem', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                  >
                                    <Eye size={14} />
                                    {t('sal.payment.previewReceipt')}
                                  </button>
                                )}
                                {storno.kind === 'offered' && (
                                  // Classes rather than an inline style, so the screen's
                                  // style-ratchet count does not move; the colours are the
                                  // legacy ones the delete button beside it uses.
                                  <button
                                    type="button"
                                    onClick={() => setStornoReceiptId(storno.receiptId)}
                                    aria-label={t('sal.payment.voidAria', {
                                      date: format(new Date(payment.payment_date), 'dd.MM.yyyy'),
                                    })}
                                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[13px] font-medium text-[color:var(--danger)] hover:bg-[color:var(--danger-subtle)]"
                                  >
                                    <Ban size={14} />
                                    {t('gq.action.void')}
                                  </button>
                                )}
                              </div>
                            ) : (
                            <div className="flex items-center justify-end space-x-2">
                              <button
                                onClick={() => { setSelectedPayment(payment); setIsPaymentModalOpen(true); }}
                                style={{ color: 'var(--accent)', borderRadius: '0.25rem', padding: '0.25rem' }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                title={t('common.edit')}
                              >
                                <Edit2 size={16} />
                              </button>
                              <button
                                onClick={() => setPaymentToDelete(payment)}
                                style={{ color: 'var(--danger)', borderRadius: '0.25rem', padding: '0.25rem' }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--danger-subtle)')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                title={t('common.delete')}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            </>)}
          </div>

          {/* Footer */}
          <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-subtle)', padding: '1.5rem' }} className="flex justify-end">
            <button
              onClick={handleClose}
              style={{ background: 'var(--bg-muted)', color: 'var(--text-primary)', borderRadius: '0.5rem', padding: '0.5rem 1rem', border: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>

      <SalaryPaymentModal
        isOpen={isPaymentModalOpen}
        onClose={() => { setIsPaymentModalOpen(false); setSelectedPayment(undefined); }}
        onSave={handleSavePayment}
        salaryId={salary.salary_id!}
        remainingBalance={remainingBalance}
        payment={selectedPayment}
        cashBlockedMessage={cashBlockedMessage}
      />

      <SalaryPaymentReceiptPreview
        receiptId={receiptPreviewId}
        onClose={() => setReceiptPreviewId(null)}
        onOpenDocuments={id => navigate('/salaries', { state: { focusReceiptId: id } })}
      />

      {/* The row's Storno: the one operation that removes a Gehaltsquittung
          payment. It runs void_salary_cash_receipt through the same voidReceipt
          helper the Gehaltsquittung list uses — there is no second path. */}
      <PaymentStornoDialog
        receiptId={stornoReceiptId}
        onClose={() => setStornoReceiptId(null)}
        onVoided={receipt => {
          setStornoReceiptId(null);
          showToast('success', t('gq.void.done', { number: receipt.receipt_number }));
          void reloadAfterStorno();
        }}
        onUnknownOutcome={() => void reloadAfterStorno()}
      />

      {/* The cash payment entered above, continued as a Gehaltsquittung: the
          balance, the place of payment, the German receipt and its one
          confirmation. Once it is issued the new row carries
          source_type = 'gehaltsquittung', so paymentRowActions gives it the
          preview button and its lock by itself. */}
      <GehaltsquittungModal
        open={receiptDraft !== null}
        onOpenChange={next => { if (!next) setReceiptDraft(null); }}
        preselect={receiptDraft}
        onChanged={() => { void fetchPayments(); void onUpdate(); }}
      />

      <ConfirmationModal
        isOpen={!!paymentToDelete}
        onClose={() => setPaymentToDelete(null)}
        onConfirm={handleDeletePayment}
        type="confirm"
        title={t('sal.payment.deleteTitle')}
        message={t('sal.payment.deleteConfirm')}
        confirmText={t('common.delete')}
      />
    </>
  );
};

/**
 * A stored amount, ready to print. `toCents` refuses anything that is not a
 * finite decimal by throwing, and this dialog renders inside a screen that sits
 * under no error boundary, so an unreadable figure becomes "—" instead of
 * unmounting the application — the same rule `overlappingSalaryAmount` above
 * follows.
 */
function storedAmountText(amount: number | string): string {
  try {
    return formatEuroCents(toCents(amount));
  } catch {
    return '—';
  }
}

/**
 * The Storno of one Gehaltsquittung, opened from its own payment row.
 *
 * THE RULE IT PRESERVES: a payment written by `confirm_salary_cash_payment` is
 * removed only by `void_salary_cash_receipt`, which in one transaction marks the
 * receipt voided with the typed reason, deletes the payment, and books the
 * amount back into the till dated the day of the void. Nothing here deletes a
 * row or computes a figure; the one call goes through `voidReceipt`, the same
 * helper the Gehaltsquittung list uses, so there is no second path.
 *
 * A `Dialog` and not a `ConfirmDialog`, because it must stay open while the RPC
 * runs and show a refusal in place: the reason is typed here, and closing on a
 * refusal would lose it.
 *
 * It loads the receipt before offering anything, and that is not decoration.
 * Voiding is idempotent in the database — an already voided receipt comes back
 * unchanged rather than raising — so a payment row that was voided in another
 * tab would report a successful Storno while writing nothing, booking no cash
 * back and dropping the reason. The load also puts the receipt's number, amount
 * and payment date in front of whoever is about to void it, read from the stored
 * row. It goes through `loadReceiptForPreview` with the caller's **own**
 * company, the path the preview takes, so a platform support session is refused
 * by name before any query goes out: it issues, voids and signs nothing here
 * (owner's decision, 18.09.2026), and since 20260921110010 the RPC refuses it
 * too.
 */
function PaymentStornoDialog({
  receiptId,
  onClose,
  onVoided,
  onUnknownOutcome,
}: {
  receiptId: string | null;
  onClose: () => void;
  onVoided: (receipt: SalaryCashReceipt) => void;
  onUnknownOutcome: () => void;
}) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const { companyId } = useAuth();
  const { effectiveCompanyId, isViewingAsCompany } = useSuperAdmin();

  const [state, setState] = useState<ReceiptLoadState<SalaryCashReceiptWithDriver>>({
    status: 'loading',
    receiptId: null,
  });
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ReceiptActionRefusal | null>(null);

  useEffect(() => {
    if (!receiptId) return undefined;
    setReason('');
    setTouched(false);
    setRefusal(null);
    setState({ status: 'loading', receiptId });

    let active = true;
    void loadReceiptForPreview(
      { receiptId, companyId, effectiveCompanyId, isViewingAsCompany },
      loadReceiptById,
    ).then(next => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, [receiptId, companyId, effectiveCompanyId, isViewingAsCompany]);

  // React paints the newly opened receiptId a frame before the effect above
  // runs, so anything this state still holds for the receipt opened before
  // counts as loading. Voiding the receipt shown a frame earlier would move cash
  // and mark the wrong document.
  const current = currentLoadState(state, receiptId);
  const receipt = current.status === 'loaded' ? current.receipt : null;
  const step = stornoStep(current);
  const reasonProblem = voidReasonProblem(reason);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!receiptId || busy || step.kind !== 'ready') return;
    setTouched(true);
    if (reasonProblem) return;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await voidReceipt(receiptId, reason.trim());
      if (result.ok) {
        onVoided(result.receipt);
        return;
      }
      setRefusal(result.refusal);
      // No answer, or one that names no reason: the Storno may have gone
      // through, so the payment list is re-read and nothing is claimed here.
      if (outcomeIsUnknown(result.refusal)) onUnknownOutcome();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={receiptId !== null}
      onOpenChange={open => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sal.payment.voidTitle')}</DialogTitle>
          <DialogDescription>{t('sal.payment.voidIntro')}</DialogDescription>
        </DialogHeader>

        {step.kind === 'loading' ? (
          <p role="status" className="py-4 text-center text-sm text-fg-muted">
            {t('sal.payment.receiptLoading')}
          </p>
        ) : null}
        {step.kind === 'refusal' ? <ReceiptAlert tone="caution">{refusalMessage(step.refusal)}</ReceiptAlert> : null}
        {/* Voiding deletes the payment, so a receipt reached from a payment row
            and found voided was voided elsewhere since this list loaded. */}
        {step.kind === 'voided' ? (
          <ReceiptAlert tone="caution">{t('sal.payment.receiptVoidedNotice')}</ReceiptAlert>
        ) : null}

        {step.kind === 'ready' && receipt ? (
          <form onSubmit={event => void submit(event)} className="grid gap-4" noValidate>
            <p className="text-sm text-fg">
              {t('sal.payment.voidReceiptLine', {
                number: receipt.receipt_number,
                amount: storedAmountText(receipt.amount),
                date: formatDate(receipt.payment_date),
              })}
            </p>
            {/* There is no "edit": the path is a Storno and then a new payment.
                Saying so here is cheaper than letting someone look for it. */}
            <p className="text-[13px] text-fg-muted">{t('sal.payment.voidThenReenter')}</p>
            <Field
              label={t('gq.void.reason')}
              hint={t('gq.void.reasonHint')}
              error={touched && reasonProblem ? refusalMessage(reasonProblem) : undefined}
              required
            >
              <Input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} />
            </Field>
            {refusal ? <ReceiptAlert tone="critical">{refusalMessage(refusal)}</ReceiptAlert> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary" disabled={busy}>
                  {t('common.cancel')}
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" loading={busy}>
                {t('gq.action.void')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('common.close')}</Button>
            </DialogClose>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default SalaryDetailsModal;
