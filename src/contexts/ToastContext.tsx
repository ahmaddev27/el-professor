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

  const colorMap: Record<ToastType, { bg: string; border: string; text: string; icon: string }> = {
    success: { bg: 'var(--success-subtle, rgba(22,163,74,0.1))', border: 'var(--success, #16a34a)', text: 'var(--success, #16a34a)', icon: 'var(--success, #16a34a)' },
    error:   { bg: 'var(--danger-subtle, rgba(220,38,38,0.1))', border: 'var(--danger, #dc2626)', text: 'var(--danger, #dc2626)', icon: 'var(--danger, #dc2626)' },
    info:    { bg: 'var(--accent-subtle, rgba(59,130,246,0.1))', border: 'var(--accent, #3b82f6)', text: 'var(--accent-text, #3b82f6)', icon: 'var(--accent-text, #3b82f6)' },
    warning: { bg: 'var(--warning-subtle, rgba(217,119,6,0.1))', border: 'var(--warning, #d97706)', text: 'var(--warning, #d97706)', icon: 'var(--warning, #d97706)' },
  };

  const Icon = icons[toast.type] || Info;
  const colors = colorMap[toast.type] || colorMap.info;

  return (
    <div
      // A modal dialog turns pointer events off on the body and closes on a press
      // outside it. This toast is outside it, so it switches them back on and keeps
      // its presses from the document: closing a message must not close the form.
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-auto flex max-w-full items-start gap-3 rounded-lg bg-overlay p-4 shadow-overlay motion-safe:animate-ui-fade-in"
      style={{
        // Over a solid surface: the dark theme's tints are 10 % washes, and a toast
        // in the middle of the page has text behind it.
        backgroundImage: `linear-gradient(${colors.bg}, ${colors.bg})`,
        border: `1px solid ${colors.border}`,
        color: colors.text,
      }}
      role="alert"
      aria-live="polite"
    >
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: colors.icon }} />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{toast.title}</p>
        {toast.message && <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{toast.message}</p>}
        {toast.action && (
          <button
            type="button"
            className="mt-2 text-sm font-semibold underline"
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
        className="flex-shrink-0 transition-colors"
        style={{ color: 'var(--text-tertiary)' }}
        aria-label={t('common.close')}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
