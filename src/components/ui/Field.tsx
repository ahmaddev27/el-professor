import { createContext, useContext, useId, type ReactNode } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { cn } from './cn';

interface FieldContextValue {
  controlId: string;
  hintId?: string;
  errorId?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

interface OwnControlProps {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
}

/**
 * The id and ARIA wiring a form control needs, taken from the surrounding
 * Field when there is one. Input and SelectTrigger call this, so a control
 * placed inside <Field> is labelled, described and marked invalid without the
 * caller threading ids by hand.
 *
 * Only attributes with a value are returned. The controls spread the result
 * after the caller's own props, and an explicit `undefined` there would erase
 * an `aria-required` or `aria-invalid` the caller set on a control outside a
 * Field.
 */
export function useFieldControlProps({ id, describedBy, invalid }: OwnControlProps) {
  const field = useContext(FieldContext);
  const describedByIds = [describedBy, field?.hintId, field?.errorId].filter(Boolean).join(' ');
  const controlId = id ?? field?.controlId;
  const attributes: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-required'?: true } = {};
  if (controlId) attributes.id = controlId;
  if (describedByIds) attributes['aria-describedby'] = describedByIds;
  if (invalid ?? field?.invalid) attributes['aria-invalid'] = true;
  if (field?.required) attributes['aria-required'] = true;
  return attributes;
}

export interface FieldProps {
  label: ReactNode;
  /** Short guidance shown under the control and read out with it. */
  hint?: ReactNode;
  /** Validation message; also marks the control invalid. */
  error?: ReactNode;
  required?: boolean;
  /** Fixed id for the control; generated when omitted. */
  id?: string;
  className?: string;
  children: ReactNode;
}

/** Label above, control, hint, then error below: the one layout every form uses. */
export function Field({ label, hint, error, required = false, id, className, children }: FieldProps) {
  const { t } = useTranslation();
  const generatedId = useId();
  const controlId = id ?? `field${generatedId.replace(/:/g, '')}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  return (
    <FieldContext.Provider value={{ controlId, hintId, errorId, invalid: Boolean(error), required }}>
      <div className={cn('grid content-start gap-1.5', className)}>
        <LabelPrimitive.Root htmlFor={controlId} className="font-ui text-[13px] font-medium text-fg-muted">
          {label}
          {required ? (
            <>
              <span aria-hidden className="ml-0.5 text-critical">*</span>
              <span className="sr-only"> ({t('common.required')})</span>
            </>
          ) : null}
        </LabelPrimitive.Root>
        {children}
        {hint ? (
          <p id={hintId} className="font-ui text-xs text-fg-subtle">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} className="flex items-start gap-1.5 font-ui text-xs font-medium text-critical">
            <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
