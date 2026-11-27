import React, { useEffect, useRef, useState } from 'react';
import { Languages, Check } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { LANGUAGES } from '../i18n';
import { cn } from './ui';

/**
 * Compact language picker for the app headers and the sign-in screen.
 *
 * `variant="ui"` is the design-system look, for the signed-out screens since
 * phase 5 batch 4, for AppLayout's header since the frame moved, for
 * AdminLayout's header since 27.11.2026 and for the legal pages since R5: token
 * classes that follow the theme, a 40 px target on a touch screen. It is the
 * only variant; the legacy `default` and the old `dark` one are gone.
 */
const LanguageSwitcher: React.FC<{ variant?: 'ui' }> = ({ variant = 'ui' }) => {
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

  const isUi = variant === 'ui';
  const active = LANGUAGES.find(l => l.code === language);

  return (
    <div className={cn('relative', isUi && 'font-ui')} ref={containerRef}>
      <button
        onClick={() => setIsOpen(open => !open)}
        className="flex h-9 items-center gap-1.5 rounded-control border border-line bg-raised px-2.5 text-xs font-semibold text-fg-muted transition-colors hover:bg-sunken hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [@media(pointer:coarse)]:h-10"
        title={t('shell.language')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={t('shell.language')}
      >
        <Languages size={15} aria-hidden={isUi || undefined} />
        <span className="uppercase">{active?.code}</span>
      </button>

      {isOpen && (
        <div
          className="absolute end-0 z-50 mt-1.5 w-40 overflow-hidden rounded-control border border-line bg-overlay p-1 shadow-overlay"
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
                className="flex h-9 w-full items-center gap-2.5 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-sm text-fg-muted transition-colors hover:bg-sunken hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus [@media(pointer:coarse)]:h-11"
              >
                <span aria-hidden="true">{option.flag}</span>
                <span className="flex-1 text-start">{option.label}</span>
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
