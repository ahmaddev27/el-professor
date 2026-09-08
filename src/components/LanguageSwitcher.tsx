import React, { useEffect, useRef, useState } from 'react';
import { Languages, Check } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { LANGUAGES } from '../i18n';

/**
 * Compact language picker for the app headers and the sign-in screen.
 *
 * `variant="dark"` matches the unauthenticated screens, which paint their own
 * dark background rather than using the theme tokens.
 */
const LanguageSwitcher: React.FC<{ variant?: 'default' | 'dark' }> = ({ variant = 'default' }) => {
  const { language, setLanguage, t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const isDark = variant === 'dark';
  const active = LANGUAGES.find(l => l.code === language);

  const triggerStyle: React.CSSProperties = isDark
    ? { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }
    : { background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' };

  const menuStyle: React.CSSProperties = isDark
    ? { background: '#0e1520', border: '1px solid rgba(255,255,255,0.1)' }
    : { background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' };

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(open => !open)}
        className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-all duration-200 hover:opacity-80"
        style={triggerStyle}
        title={t('shell.language')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={t('shell.language')}
      >
        <Languages size={15} />
        <span className="uppercase">{active?.code}</span>
      </button>

      {isOpen && (
        <div
          className="absolute right-0 mt-1.5 w-40 rounded-xl overflow-hidden z-50 p-1"
          style={menuStyle}
          role="listbox"
        >
          {LANGUAGES.map(option => {
            const selected = option.code === language;
            return (
              <button
                key={option.code}
                role="option"
                aria-selected={selected}
                onClick={() => { setLanguage(option.code); setIsOpen(false); }}
                className="w-full px-2.5 py-2 rounded-lg flex items-center gap-2.5 text-sm transition-colors"
                style={{ color: isDark ? 'rgba(255,255,255,0.75)' : 'var(--text-secondary)' }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = isDark
                    ? 'rgba(255,255,255,0.06)'
                    : 'var(--bg-muted)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                <span aria-hidden="true">{option.flag}</span>
                <span className="flex-1 text-left">{option.label}</span>
                {selected && <Check size={14} className="flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default LanguageSwitcher;
