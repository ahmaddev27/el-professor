import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useTranslation } from './LanguageContext';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  /** A button inside the toast, e.g. retry. Pressing it also dismisses the toast. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastContextType {
  showToast: (type: ToastType, title: string, message?: string, duration?: number, action?: ToastAction) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (type: ToastType, title: string, message?: string, duration: number = 5000, action?: ToastAction) => {
      const id = Math.random().toString(36).substring(7);
      const toast: Toast = { id, type, title, message, duration, action };

      setToasts((prev) => [...prev, toast]);

      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast]
  );

  const success = useCallback(
    (title: string, message?: string) => showToast('success', title, message),
    [showToast]
  );

  const error = useCallback(
    (title: string, message?: string) => showToast('error', title, message, 7000),
    [showToast]
  );

  const info = useCallback(
    (title: string, message?: string) => showToast('info', title, message),
    [showToast]
  );

  const warning = useCallback(
    (title: string, message?: string) => showToast('warning', title, message),
    [showToast]
  );

  return (
    <ToastContext.Provider value={{ showToast, success, error, info, warning }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
};

const ToastContainer: React.FC<{ toasts: Toast[]; onRemove: (id: string) => void }> = ({
  toasts,
  onRemove,
}) => {
  // Centred, and above every dialog. It sat at the top right on z-50, and the
  // Sheet (receipts, drivers, vehicles) opens on the right on z-50 from a portal
  // later in the document, so a message raised while a form was open was painted
  // underneath it: Save seemed to do nothing. Nothing in the app may stack above
  // this level (ToastContext.render.test.ts reads the source). The banner offset
  // is the Sheet's own, so a toast never hides under the staging banner.
  return (
    <div className="pointer-events-none fixed left-1/2 top-[calc(var(--env-banner-height,0px)+1rem)] z-[80] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
      ))}
    </div>
  );
};

const ToastItem: React.FC<{ toast: Toast; onRemove: (id: string) => void }> = ({
  toast,
  onRemove,
}) => {
  // LanguageProvider is the outermost provider in main.tsx, so this reads the
  // chosen language and not the context default.
  const { t } = useTranslation();
  const icons: Record<ToastType, React.ElementType> = {
    success: CheckCircle,
    error: XCircle,
    info: Info,
    warning: AlertTriangle,
  };

  // Presentation (phase 5): status by token, icon and words, never colour alone.
  const toneMap: Record<ToastType, { ring: string; text: string }> = {
    success: { ring: 'border-positive/30', text: 'text-positive' },
    error: { ring: 'border-critical/30', text: 'text-critical' },
    info: { ring: 'border-brand/30', text: 'text-brand-text' },
    warning: { ring: 'border-caution/30', text: 'text-caution' },
  };

  const Icon = icons[toast.type] || Info;
  const tone = toneMap[toast.type] || toneMap.info;

  return (
    <div
      // A modal dialog turns pointer events off on the body and closes on a press
      // outside it. This toast is outside it, so it switches them back on and keeps
      // its presses from the document: closing a message must not close the form.
      onPointerDown={(event) => event.stopPropagation()}
      className={`pointer-events-auto flex max-w-full items-start gap-3 rounded-tile border glass-strong p-4 font-ui motion-safe:animate-ui-fade-in ${tone.ring}`}
      role="alert"
      aria-live="polite"
    >
      <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${tone.text}`} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm text-fg">{toast.title}</p>
        {toast.message && <p className="text-sm mt-1 text-fg-muted">{toast.message}</p>}
        {toast.action && (
          <button
            type="button"
            className={`mt-2 text-sm font-semibold underline ${tone.text}`}
            onClick={() => {
              onRemove(toast.id);
              toast.action?.onClick();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => onRemove(toast.id)}
        className="flex-shrink-0 transition-colors text-fg-subtle hover:text-fg inline-flex items-center justify-center [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:-m-2"
        aria-label={t('common.close')}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
