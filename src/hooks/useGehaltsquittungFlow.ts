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
  browserSessionStorage,
  checkPaymentDate,
  clearPendingAttempt,
  createRequestId,
  findOverlappingSalary,
  nextAttempt,
  outcomeIsUnknown,
  readAmountField,
  readPendingAttempt,
  sameSnapshot,
  savePendingAttempt,
  snapshotFromFigures,
  snapshotFromReceiptRow,
  type PaymentAttempt,
  type PendingReceiptAttempt,
  type ReceiptActionRefusal,
  type ReceiptSnapshot,
  type StorageLike,
} from '../utils/salaryCashReceiptFlow';

/**
 * State and actions behind GehaltsquittungModal: choose a salary, show its
 * balance, preview the receipt, confirm it once, attach the signed copy.
 *
 * Every figure on screen comes from computeBalanceFigures and
 * computeReceiptFigures, in integer cents. The database reads the salary again
 * under lock and decides at confirmation; after it, the stored row and not the
 * preview is what the receipt prints.
 *
 * A confirmation whose outcome is unknown outlives this dialog. From the
 * moment the request leaves until the database answers, the attempt is held
 * here and in the tab's sessionStorage, and it is resumed when the dialog
 * opens again or after a reload — so the same payment is never sent a second
 * time under a new request id, which the database would book as a second
 * receipt.
 */

export const FLOW_STEPS = ['select', 'amount', 'preview', 'done'] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export type Loadable<T> = { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

export interface BalanceInputs {
  salary: ReceiptSalary;
  payments: SalaryPaymentInput[];
}

export type AmountError = 'invalid' | 'too_large' | 'already_paid' | 'overpayment';

/**
 * A salary and an amount the caller already chose elsewhere — the cash payment
 * added on the salary screen. Read once, when the dialog opens: the driver and
 * the salary are then fixed and the flow starts at the amount step, which is
 * also where the place of payment is, a field the salary form does not have.
 */
export interface GehaltsquittungPreselect {
  driverId: string;
  salaryId: string;
  /** Prefilled, still editable; the balance decides whether it may be paid. */
  amountCents?: number | null;
  /** YYYY-MM-DD */
  paymentDate?: string | null;
}

export interface GehaltsquittungFlowOptions {
  /** Loads and acts only while true: the dialog is open and the caller may confirm in their own company. */
  enabled: boolean;
  companyId: string | null;
  /** The place of payment offered when the dialog opens. */
  defaultPlace: string;
  /** After a receipt is issued or its signed copy attached. */
  onChanged?: () => void;
  /** Where an unanswered attempt is kept; the tab's sessionStorage by default. */
  storage?: StorageLike | null;
  /** A driver and salary chosen before the dialog opened; null for the free flow. */
  preselect?: GehaltsquittungPreselect | null;
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

export function useGehaltsquittungFlow({
  enabled,
  companyId,
  defaultPlace,
  onChanged,
  storage,
  preselect = null,
}: GehaltsquittungFlowOptions) {
  const [step, setStep] = useState<FlowStep>('select');
  const [driverId, setDriverId] = useState('');
  const [salaryId, setSalaryId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [paymentDate, setPaymentDate] = useState(() => berlinToday());
  const [place, setPlace] = useState(defaultPlace);
  const [showMissing, setShowMissing] = useState(false);
  const [attempt, setAttempt] = useState<PaymentAttempt | null>(null);
  const [pending, setPending] = useState<PendingReceiptAttempt | null>(null);
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
  // A ref, because the caller builds this object while it renders: reading it
  // through the dependency list would restart the flow on every parent render.
  const preselectRef = useRef(preselect);
  preselectRef.current = preselect;
  const attemptRef = useRef<PaymentAttempt | null>(null);
  attemptRef.current = attempt;
  const store = useMemo(() => (storage === undefined ? browserSessionStorage() : storage), [storage]);
  const storeRef = useRef(store);
  storeRef.current = store;

  /** True while a confirmation is out and the database has not answered it. */
  const unresolved = attempt?.state === 'uncertain';

  // Opening resumes an unanswered confirmation, from this dialog session or
  // from the tab's storage after a reload. Closing keeps it; only a settled
  // dialog is cleared, so the next open starts from a clean selection.
  useEffect(() => {
    if (enabled) {
      if (attemptRef.current?.state === 'uncertain') {
        setStep('preview');
        return;
      }
      const stored = companyId ? readPendingAttempt(storeRef.current, companyId) : null;
      if (stored) {
        setPending(stored);
        setAttempt({ requestId: stored.requestId, input: stored.input, state: 'uncertain' });
        setDriverId(stored.driver.id);
        setSalaryId(stored.input.salaryId);
        setAmountText(formatCentsForInput(stored.input.amountCents));
        setPaymentDate(stored.input.paymentDate);
        setPlace(stored.input.place);
        setRefusal('no_response');
        setStep('preview');
        return;
      }
      // A preselected salary skips the first step. It is read after the stored
      // attempt on purpose: an unanswered confirmation has to be settled first,
      // whichever screen started it, or the same payment could be sent twice.
      const chosen = preselectRef.current;
      setPaymentDate(chosen?.paymentDate || berlinToday());
      setPlace(defaultPlaceRef.current);
      if (chosen) {
        setDriverId(chosen.driverId);
        setSalaryId(chosen.salaryId);
        setAmountText(chosen.amountCents != null ? formatCentsForInput(chosen.amountCents) : '');
        setStep('amount');
      }
      return;
    }
    if (attemptRef.current?.state === 'uncertain') return;
    setStep('select');
    setDriverId('');
    setSalaryId('');
    setAmountText('');
    setShowMissing(false);
    setAttempt(null);
    setPending(null);
    setRefusal(null);
    setReceipt(null);
    setConfirmedPreview(null);
    setUploadRefusal(null);
    setUploaded(false);
  }, [enabled, companyId]);

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
  /** The driver and the salary were chosen elsewhere, so this flow has no select step. */
  const locked = preselect !== null;
  const outcomeUnknown = unresolved && refusal !== null && outcomeIsUnknown(refusal);
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
    if (sending || unresolved || conflict) return;
    setRefusal(null);
    if (step === 'preview') {
      setStep('amount');
      return;
    }
    // A preselected flow has no step to go back to; its dialog offers a cancel.
    if (locked) return;
    setStep('select');
  };

  const confirm = async () => {
    if (sendingRef.current || !companyId) return;
    const resume = unresolved ? pending : null;
    if (!resume && (!figures || amountField.cents === null || !driver || !salary)) return;

    sendingRef.current = true;
    setSending(true);
    setRefusal(null);
    let sent = false;

    try {
      let record: PendingReceiptAttempt;
      let outgoing: PaymentAttempt;

      if (resume) {
        // The same request, field for field: the database answers a repeat
        // with the receipt it already stored.
        record = resume;
        outgoing = { requestId: resume.requestId, input: resume.input, state: 'uncertain' };
      } else {
        // Checked above; repeated so the types narrow inside the guarded block,
        // where creating the request id may also throw.
        if (!figures || amountField.cents === null || !driver || !salary) return;
        const input = { salaryId, amountCents: amountField.cents, paymentDate, place: place.trim() };
        outgoing = nextAttempt(attempt, input, createRequestId);
        record = {
          companyId,
          requestId: outgoing.requestId,
          input,
          driver: { id: driver.id, name: driver.name, gender: driver.gender },
          period: { start: salary.period_start, end: salary.period_end },
          shown: snapshotFromFigures(figures),
        };

        // Before a first send, make sure the preview still shows the database's
        // balance. A retry skips this: its first send may be the booking that
        // changed the balance, and the database hands that receipt back.
        const fresh = await loadSalaryBalanceInputs(companyId, input.salaryId);
        if (!fresh) {
          setAttempt(outgoing);
          setRefusal('salary_not_found');
          return;
        }
        const freshResult = computeReceiptFigures(fresh.salary, fresh.payments, input.amountCents);
        if (!freshResult.ok || !sameSnapshot(snapshotFromFigures(freshResult.figures), record.shown)) {
          balance.replace(fresh);
          setAttempt(outgoing);
          setRefusal('stale_figures');
          setStep('amount');
          return;
        }
      }

      // From here the outcome is unknown: the request may commit even when no
      // answer comes back, so the id is stored before it leaves. A reload in
      // flight then resumes it instead of starting a second payment.
      setAttempt({ ...outgoing, state: 'uncertain' });
      setPending(record);
      savePendingAttempt(storeRef.current, record);
      sent = true;

      const result = await confirmCashPayment({ requestId: record.requestId, ...record.input });

      if (result.ok) {
        clearPendingAttempt(storeRef.current, companyId);
        setPending(null);
        setAttempt(null);
        setReceipt(result.receipt);
        setConfirmedPreview(record.shown);
        setStep('done');
        onChangedRef.current?.();
        return;
      }

      setRefusal(result.refusal);
      // No answer: the attempt stays uncertain in the dialog and in storage,
      // and only a retry with the same id is offered. The payment may have been
      // booked, so a list beside the dialog reloads to show it.
      if (outcomeIsUnknown(result.refusal)) {
        onChangedRef.current?.();
        return;
      }

      // The database refused, so its transaction rolled back and nothing is pending.
      clearPendingAttempt(storeRef.current, companyId);
      setPending(null);
      setAttempt({ ...outgoing, state: 'refused' });
      if (result.refusal === 'request_id_conflict') {
        balance.reload();
      } else if (balanceMayHaveChanged(result.refusal)) {
        balance.reload();
        setStep('amount');
      }
    } catch {
      // Before the send: the balance check or the request id failed, and nothing
      // was booked. After it: the request is out with an unknown outcome.
      setRefusal(sent ? 'no_response' : 'not_sent');
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
    setPending(null);
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
    locked,
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
    pending,
    unresolved,
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
