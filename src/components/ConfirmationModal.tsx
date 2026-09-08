import React, { useState } from 'react';
import { X, AlertTriangle, CheckCircle, XCircle, Info } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  title: string;
  message: string;
  type: 'confirm' | 'success' | 'error' | 'info';
  confirmText?: string;
  cancelText?: string;
  confirmButtonClass?: string;
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  type,
  confirmText,
  cancelText,
}) => {
  const { t } = useTranslation();
  // Callers may override; otherwise fall back to the translated defaults.
  const confirmLabel = confirmText ?? t('common.confirm');
  const cancelLabel = cancelText ?? t('common.cancel');
  const [cancelHover, setCancelHover] = useState(false);
  const [closeHover, setCloseHover] = useState(false);
  const [confirmHover, setConfirmHover] = useState(false);

  if (!isOpen) return null;

  const getIcon = () => {
    switch (type) {
      case 'confirm':
        return <AlertTriangle style={{ color: 'var(--warning)' }} size={48} />;
      case 'success':
        return <CheckCircle style={{ color: 'var(--success)' }} size={48} />;
      case 'error':
        return <XCircle style={{ color: 'var(--danger)' }} size={48} />;
      case 'info':
        return <Info style={{ color: 'var(--accent-text)' }} size={48} />;
      default:
        return <Info style={{ color: 'var(--accent-text)' }} size={48} />;
    }
  };

  const getConfirmBgColor = () => {
    switch (type) {
      case 'confirm': return confirmHover ? 'var(--warning)' : 'var(--warning)';
      case 'success': return confirmHover ? 'var(--success)' : 'var(--success)';
      case 'error': return confirmHover ? 'var(--danger)' : 'var(--danger)';
      case 'info': return confirmHover ? 'var(--accent-hover)' : 'var(--accent)';
      default: return confirmHover ? 'var(--accent-hover)' : 'var(--accent)';
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div
        className="rounded-xl w-full max-w-md transform transition-all"
        style={{
          background: 'var(--bg-surface)',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--border)'
        }}
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-3">
              {getIcon()}
              <h3 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
            </div>
            <button
              onClick={onClose}
              style={{ color: closeHover ? 'var(--text-secondary)' : 'var(--text-tertiary)', transition: 'color 0.15s' }}
              onMouseEnter={() => setCloseHover(true)}
              onMouseLeave={() => setCloseHover(false)}
            >
              <X size={24} />
            </button>
          </div>

          <div className="mb-6">
            <p className="leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{message}</p>
          </div>

          <div className="flex justify-end space-x-3">
            {type === 'confirm' && (
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg font-medium transition-colors"
                style={{
                  color: 'var(--text-primary)',
                  background: cancelHover ? 'var(--bg-muted)' : 'var(--bg-subtle)',
                  border: '1px solid var(--border)'
                }}
                onMouseEnter={() => setCancelHover(true)}
                onMouseLeave={() => setCancelHover(false)}
              >
                {cancelLabel}
              </button>
            )}
            <button
              onClick={() => {
                if (onConfirm) onConfirm();
                onClose();
              }}
              className="px-4 py-2 text-white rounded-lg font-medium transition-colors"
              style={{
                background: getConfirmBgColor(),
                opacity: confirmHover ? 0.9 : 1
              }}
              onMouseEnter={() => setConfirmHover(true)}
              onMouseLeave={() => setConfirmHover(false)}
            >
              {type === 'confirm' ? confirmLabel : 'OK'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationModal;
