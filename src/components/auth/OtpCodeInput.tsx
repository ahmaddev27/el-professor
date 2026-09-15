import React, { useEffect, useId, useRef } from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { OTP_CODE_LENGTH } from '../../lib/otpClient';
import {
  deleteBackward,
  deleteForward,
  enterDigits,
  focusableIndex,
  pasteDigits,
  type CodeEdit,
} from '../../lib/otpUi';
import type { AuthSurface } from './authStyles';

export interface OtpCodeInputProps {
  /** Up to six digits, contiguous from the first box. */
  value: string;
  onChange: (value: string) => void;
  /** Fired when an edit by the user fills the sixth box. */
  onComplete: (code: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  /** Space-separated ids of the hint and message the boxes are described by. */
  describedBy?: string;
  surface?: AuthSurface;
}

const BOXES = Array.from({ length: OTP_CODE_LENGTH }, (_, index) => index);
const LAST_BOX = OTP_CODE_LENGTH - 1;

/**
 * Six one-digit boxes for a one-time code.
 *
 * The first box carries `autocomplete="one-time-code"` so the OS can offer the
 * code from the mail, a paste into any box fills all six, Backspace walks back,
 * and arrow/Home/End keys move between boxes. How each edit changes the code is
 * decided by the pure helpers in lib/otpUi, which are unit-tested.
 */
const OtpCodeInput: React.FC<OtpCodeInputProps> = ({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  autoFocus = false,
  describedBy,
  surface = 'dark',
}) => {
  const { t } = useTranslation();
  const labelId = useId();
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const pendingSelect = useRef<number | null>(null);

  // The code as of the latest edit, which the handlers read instead of `value`.
  // Moving focus to the next box fires its focus handler synchronously, before
  // React has rendered the digit that unlocked it; judged by the rendered
  // `value`, that box was still out of reach and focus went back one box.
  // Chrome and Firefox recovered because their select() refocuses the box after
  // the render. WebKit's select() does not, so on Safari and every iOS browser
  // each typed digit overwrote the one before it and the code never completed.
  const latest = useRef(value);
  latest.current = value;

  // Selecting before React writes the new digit selects the old one, so the
  // selection is repeated after the render. A selected digit is replaced by
  // the next keystroke instead of sitting next to it.
  useEffect(() => {
    const index = pendingSelect.current;
    if (index === null) return;
    pendingSelect.current = null;
    boxes.current[index]?.select();
  });

  const focusBox = (index: number) => {
    const box = boxes.current[index];
    if (!box) return;
    box.focus();
    box.select();
    pendingSelect.current = index;
  };

  useEffect(() => {
    if (autoFocus && !disabled) focusBox(focusableIndex(latest.current, LAST_BOX));
    // On mount only: refocusing on later changes would pull focus away from the buttons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = (edit: CodeEdit) => {
    const changed = edit.value !== latest.current;
    // Before focus moves, so the focus handler already sees this edit.
    latest.current = edit.value;
    if (changed) onChange(edit.value);
    focusBox(edit.focusIndex);
    if (changed && edit.value.length === OTP_CODE_LENGTH) onComplete(edit.value);
  };

  // Reached by mobile keyboards, autofill and IME input; desktop digits are
  // handled in onKeyDown before a change event exists.
  const handleChange = (index: number, raw: string) => {
    const code = latest.current;
    if (raw === '') {
      apply(deleteBackward(code, index));
      return;
    }
    const previous = code[index] ?? '';
    let typed = raw;
    // The selection was lost, so the old digit is still in the box beside the new one.
    if (previous && raw.length === 2 && raw.includes(previous)) {
      typed = raw[0] === previous ? raw[1] : raw[0];
    }
    apply(enterDigits(code, index, typed));
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const code = latest.current;
    switch (event.key) {
      case 'Backspace':
        event.preventDefault();
        apply(deleteBackward(code, index));
        return;
      case 'Delete':
        event.preventDefault();
        apply(deleteForward(code, index));
        return;
      case 'ArrowLeft':
        event.preventDefault();
        focusBox(Math.max(index - 1, 0));
        return;
      case 'ArrowRight':
        event.preventDefault();
        focusBox(focusableIndex(code, index + 1));
        return;
      case 'Home':
        event.preventDefault();
        focusBox(0);
        return;
      case 'End':
        event.preventDefault();
        focusBox(focusableIndex(code, LAST_BOX));
        return;
      default:
        if (/^\d$/.test(event.key)) {
          event.preventDefault();
          apply(enterDigits(code, index, event.key));
        }
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const edit = pasteDigits(event.clipboardData.getData('text'));
    if (edit) apply(edit);
  };

  const handleFocus = (index: number, event: React.FocusEvent<HTMLInputElement>) => {
    const allowed = focusableIndex(latest.current, index);
    if (allowed !== index) {
      focusBox(allowed);
      return;
    }
    event.target.select();
  };

  const isDark = surface === 'dark';
  const boxClass = isDark
    ? `flex-1 min-w-0 h-12 sm:h-14 text-center text-xl font-mono font-semibold rounded-xl bg-white/5 border text-white transition-all focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-40 disabled:cursor-not-allowed ${
        invalid ? 'border-red-500/60' : 'border-white/10 focus:border-cyan-500/40'
      }`
    : 'flex-1 min-w-0 h-12 text-center text-xl font-mono font-semibold rounded-lg outline-none transition-all focus:ring-2 disabled:opacity-40 disabled:cursor-not-allowed';
  const boxStyle: React.CSSProperties | undefined = isDark
    ? undefined
    : {
        background: 'var(--bg-muted)',
        border: `1px solid ${invalid ? 'var(--danger)' : 'var(--border)'}`,
        color: 'var(--text-primary)',
      };

  return (
    <div>
      <span
        id={labelId}
        className={isDark ? 'block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2' : 'block text-xs uppercase tracking-wide mb-2'}
        style={isDark ? undefined : { color: 'var(--text-tertiary)' }}
      >
        {t('otp.code.label')}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex gap-2">
        {BOXES.map(index => (
          <input
            key={index}
            ref={element => { boxes.current[index] = element; }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={OTP_CODE_LENGTH}
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            value={value[index] ?? ''}
            aria-label={t('otp.code.digitAria', { n: index + 1 })}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            onChange={event => handleChange(index, event.target.value)}
            onKeyDown={event => handleKeyDown(index, event)}
            onPaste={handlePaste}
            onFocus={event => handleFocus(index, event)}
            className={boxClass}
            style={boxStyle}
          />
        ))}
      </div>
    </div>
  );
};

export default OtpCodeInput;
