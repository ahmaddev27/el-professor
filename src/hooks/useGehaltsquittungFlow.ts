import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  confirmCashPayment,
  loadDriverSalaries,
  loadReceiptDrivers,
  loadSalaryBalanceInputs,
  uploadSignedCopy,
  type ReceiptDriver,
  type ReceiptSalary,
  type SalaryCashReceipt,
} from '../lib/salaryCashReceipts';
import { formatCentsForInput } from '../utils/money';
import { computeBalanceFigures, computeReceiptFigures, type SalaryPaymentInput } from '../utils/salaryCashReceipt';
import {
  balanceMayHaveChanged,
  berlinToday,
  checkPaymentDate,
  findOverlappingSalary,
  nextAttempt,
  outcomeIsUnknown,
  readAmountField,
  sameSnapshot,
  snapshotFromFigures,
  snapshotFromReceiptRow,
  type PaymentAttempt,
  type ReceiptActionRefusal,
  type ReceiptSnapshot,
} from '../utils/salaryCashReceiptFlow';

/**
 * State and actions behind GehaltsquittungModal: choose a salary, show its
 * balance, preview the receipt, confirm it once, attach the signed copy.
 *
 * Every figure on screen comes from computeBalanceFigures and
 * computeReceiptFigures, in integer cents. The database reads the salary again
 * under lock and decides at confirmation; after it, the stored row and not the
 * preview is what the receipt prints.
 */

export const FLOW_STEPS = ['select', 'amount', 'preview', 'done'] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export type Loadable<T> = { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

export interface BalanceInputs {
  salary: ReceiptSalary;
  payments: SalaryPaymentInput[];
}

export type AmountError = 'invalid' | 'too_large' | 'already_paid' | 'overpayment';

export interface GehaltsquittungFlowOptions {
  /** Loads and acts only while true: the dialog is open and the caller may confirm in their own company. */
  enabled: boolean;
  companyId: string | null;
  /** The place of payment offered when the dialog opens. */
  defaultPlace: string;
  /** After a receipt is issued or its signed copy attached. */
  onChanged?: () => void;
}

/** Loads whenever `key` changes to a new non-null value; a response for an older key is dropped. */
function useLoadable<T>(key: string | null, load: () => Promise<T>) {
  const [state, setState] = useState<Loadable<T>>({ status: 'idle' });
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle' });
      return undefined;
    }
    let active = true;
    setState({ status: 'loading' });
    loadRef.current().then(
      data => {
        if (active) setState({ status: 'ready', data });
      },
      () => {
        if (active) setState({ status: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, [key, version]);

  const reload = useCallback(() => setVersion(current => current + 1), []);
  const replace = useCallback((data: T) => setState({ status: 'ready', data }), []);
  return { state, reload, replace };
}

export function useGehaltsquittungFlow({ enabled, companyId, defaultPlace, onChanged }: GehaltsquittungFlowOptions) {
  const [step, setStep] = useState<FlowStep>('select');
  const [driverId, setDriverId] = useState('');
  const [salaryId, setSalaryId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [paymentDate, setPaymentDate] = useState(() => berlinToday());
  const [place, setPlace] = useState(defaultPlace);
  const [showMissing, setShowMissing] = useState(false);
  const [attempt, setAttempt] = useState<PaymentAttempt | null>(null);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<ReceiptActionRefusal | null>(null);
  const [receipt, setReceipt] = useState<SalaryCashReceipt | null>(null);
  const [confirmedPreview, setConfirmedPreview] = useState<ReceiptSnapshot | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadRefusal, setUploadRefusal] = useState<ReceiptActionRefusal | null>(null);
  const [uploaded, setUploaded] = useState(false);

  // A ref, not state: two clicks in one frame both see state from before either.
  const sendingRef = useRef(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const defaultPlaceRef = useRef(defaultPlace);
  defaultPlaceRef.current = defaultPlace;

  // Cleared when the dialog closes, so no loader starts for the last session's
  // selection when it opens again; today's date and the place are set on open.
  useEffect(() => {
    if (enabled) {
      setPaymentDate(berlinToday());
      setPlace(defaultPlaceRef.current);
      return;
    }
    setStep('select');
    setDriverId('');
    setSalaryId('');
    setAmountText('');
    setShowMissing(false);
    setAttempt(null);
    setRefusal(null);
    setReceipt(null);
    setConfirmedPreview(null);
    setUploadRefusal(null);
    setUploaded(false);
  }, [enabled]);

  // Company settings can arrive after the dialog opened.
  useEffect(() => {
    setPlace(current => (current === '' ? defaultPlace : current));
  }, [defaultPlace]);

  const active = enabled && companyId !== null;
  const company = companyId ?? '';
  const drivers = useLoadable(active ? `drivers:${company}` : null, () => loadReceiptDrivers(company));
  const salaries = useLoadable(active && driverId ? `salaries:${company}:${driverId}` : null, () =>
    loadDriverSalaries(company, driverId),
  );
  const balance = useLoadable<BalanceInputs | null>(active && salaryId ? `balance:${company}:${salaryId}` : null, () =>
    loadSalaryBalanceInputs(company, salaryId),
  );

  // ── Derived ─────────────────────────────────────────────────────────────
  const today = berlinToday();
  const driver: ReceiptDriver | null =
    drivers.state.status === 'ready' ? drivers.state.data.find(candidate => candidate.id === driverId) ?? null : null;
  const salary: ReceiptSalary | null =
    salaries.state.status === 'ready' ? salaries.state.data.find(candidate => candidate.id === salaryId) ?? null : null;
  const overlap =
    salary && salaries.state.status === 'ready' ? findOverlappingSalary(salary, salaries.state.data) : null;
  const balanceInputs = balance.state.status === 'ready' ? balance.state.data : null;
  const salaryMissing = balance.state.status === 'ready' && balance.state.data === null;

  const balanceFigures = useMemo(
    () => (balanceInputs ? computeBalanceFigures(balanceInputs.salary, balanceInputs.payments) : null),
    [balanceInputs],
  );
  const amountField = readAmountField(amountText);
  const figuresResult = useMemo(
    () =>
      balanceInputs && amountField.cents !== null
        ? computeReceiptFigures(balanceInputs.salary, balanceInputs.payments, amountField.cents)
        : null,
    [balanceInputs, amountField.cents],
  );
  const figures = figuresResult?.ok ? figuresResult.figures : null;

  let amountError: AmountError | null = amountField.problem;
  if (!amountError && figuresResult && !figuresResult.ok) {
    amountError = figuresResult.refusal === 'invalid_amount' ? 'invalid' : figuresResult.refusal;
  }
  const dateProblem = checkPaymentDate(paymentDate, today);
  const placeMissing = place.trim() === '';
  const alreadyPaid = balanceFigures !== null && balanceFigures.remainingBeforeCents === 0;
  const canContinue = salary !== null && balanceInputs !== null && overlap === null;
  const outcomeUnknown = attempt?.state === 'uncertain' && refusal !== null && outcomeIsUnknown(refusal);
  const conflict = refusal === 'request_id_conflict';
  const differsFromPreview =
    receipt !== null && confirmedPreview !== null && !sameSnapshot(snapshotFromReceiptRow(receipt), confirmedPreview);

  // ── Actions ─────────────────────────────────────────────────────────────
  const selectDriver = (id: string) => {
    setDriverId(id);
    setSalaryId('');
    setAmountText('');
    setShowMissing(false);
    setRefusal(null);
  };

  const selectSalary = (id: string) => {
    setSalaryId(id);
    setAmountText('');
    setShowMissing(false);
    setRefusal(null);
  };

  const fillRemaining = () => {
    if (balanceFigures && balanceFigures.remainingBeforeCents > 0) {
      setAmountText(formatCentsForInput(balanceFigures.remainingBeforeCents));
    }
  };

  const goToAmount = () => {
    if (!canContinue) return;
    setRefusal(null);
    setStep('amount');
  };

  const goToPreview = () => {
    setShowMissing(true);
    if (figures === null || dateProblem !== null || placeMissing || overlap !== null) return;
    setRefusal(null);
    setStep('preview');
  };

  const goBack = () => {
    if (sending || attempt?.state === 'uncertain' || conflict) return;
    setRefusal(null);
    setStep(step === 'preview' ? 'amount' : 'select');
  };

  const confirm = async () => {
    if (sendingRef.current || !companyId || !figures || amountField.cents === null) return;
    sendingRef.current = true;
    setSending(true);
    setRefusal(null);

    const input = { salaryId, amountCents: amountField.cents, paymentDate, place: place.trim() };
    const shown = snapshotFromFigures(figures);
    let current = nextAttempt(attempt, input, () => crypto.randomUUID());

    try {
      // Before a first send, make sure the preview still shows the database's
      // balance. A retry skips this: its first send may be the booking that
      // changed the balance, and the database hands that receipt back.
      if (current.state !== 'uncertain') {
        const fresh = await loadSalaryBalanceInputs(companyId, salaryId);
        if (!fresh) {
          setAttempt(current);
          setRefusal('salary_not_found');
          return;
        }
        const freshResult = computeReceiptFigures(fresh.salary, fresh.payments, input.amountCents);
        if (!freshResult.ok || !sameSnapshot(snapshotFromFigures(freshResult.figures), shown)) {
          balance.replace(fresh);
          setAttempt(current);
          setRefusal('stale_figures');
          setStep('amount');
          return;
        }
      }

      current = { ...current, state: 'uncertain' };
      setAttempt(current);
      const result = await confirmCashPayment({ requestId: current.requestId, ...input });

      if (result.ok) {
        setAttempt(null);
        setReceipt(result.receipt);
        setConfirmedPreview(shown);
        setStep('done');
        onChangedRef.current?.();
        return;
      }

      setRefusal(result.refusal);
      // No answer: the attempt stays uncertain, and only a retry with the same id is offered.
      // The payment may have been booked, so a list beside the dialog reloads to show it.
      if (outcomeIsUnknown(result.refusal)) {
        onChangedRef.current?.();
        return;
      }

      setAttempt({ ...current, state: 'refused' });
      if (result.refusal === 'request_id_conflict') {
        balance.reload();
      } else if (balanceMayHaveChanged(result.refusal)) {
        balance.reload();
        setStep('amount');
      }
    } catch {
      // Only the balance check before sending can throw; an RPC error is a result.
      setAttempt(current);
      setRefusal('no_response');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const uploadCopy = async (file: File) => {
    if (!receipt || !companyId || uploading) return;
    setUploading(true);
    setUploadRefusal(null);
    setUploaded(false);
    try {
      const result = await uploadSignedCopy(companyId, receipt, file);
      if (result.ok) {
        setReceipt(result.receipt);
        setUploaded(true);
        onChangedRef.current?.();
      } else {
        setUploadRefusal(result.refusal);
      }
    } catch {
      setUploadRefusal('upload_failed');
    } finally {
      setUploading(false);
    }
  };

  const startAnother = () => {
    setStep('select');
    setSalaryId('');
    setAmountText('');
    setShowMissing(false);
    setRefusal(null);
    setAttempt(null);
    setReceipt(null);
    setConfirmedPreview(null);
    setUploadRefusal(null);
    setUploaded(false);
    salaries.reload();
  };

  return {
    step,
    drivers: drivers.state,
    salaries: salaries.state,
    balance: balance.state,
    reloadDrivers: drivers.reload,
    reloadSalaries: salaries.reload,
    reloadBalance: balance.reload,
    driverId,
    salaryId,
    driver,
    salary,
    overlap,
    salaryMissing,
    balanceFigures,
    figures,
    alreadyPaid,
    amountText,
    setAmountText,
    amountError,
    paymentDate,
    setPaymentDate,
    dateProblem,
    today,
    place,
    setPlace,
    placeMissing,
    showMissing,
    canContinue,
    attempt,
    sending,
    refusal,
    outcomeUnknown,
    conflict,
    receipt,
    differsFromPreview,
    uploading,
    uploadRefusal,
    uploaded,
    selectDriver,
    selectSalary,
    fillRemaining,
    goToAmount,
    goToPreview,
    goBack,
    confirm,
    uploadCopy,
    startAnother,
  };
}

export type GehaltsquittungFlow = ReturnType<typeof useGehaltsquittungFlow>;
