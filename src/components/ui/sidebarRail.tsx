import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useDirection } from '@radix-ui/react-direction';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';

/**
 * The collapsible sidebar rail (Reidey spec §6.8, owner 27.11.2026), shared by
 * the company shell's `Sidebar`, the panel's `AdminSidebar` and `AppShell`.
 *
 * Collapsed, the sidebar is a 68 px icon rail: labels hide, group labels become
 * hairlines, and every item keeps its name twice — as its aria-label, and as a
 * tooltip on hover and keyboard focus. The rail exists only where the sidebar
 * is a pane beside the sheet (`lg` and up); below that the sidebar is the
 * drawer and always shows its labels, whatever was stored.
 *
 * The spec's rail breakpoint is 961 px because its drawer ends there; ours ends
 * at Tailwind's `lg` (1024 px), and the rail follows the drawer, not the number.
 */

/** The one key the collapse choice is kept under. A second key would split it. */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'ya-shell-collapsed';

/** Tailwind's `lg`, where the fixed sidebar replaces the drawer. */
export const SHELL_DESKTOP_QUERY = '(min-width: 1024px)';

/** The sidebar's id in both shells, for the toggles' aria-controls. */
export const SHELL_SIDEBAR_ID = 'shell-sidebar';

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // A remembered sidebar width is a convenience; the shell works without it.
  }
}

function desktopMatches(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(SHELL_DESKTOP_QUERY).matches;
}

/**
 * The stored choice, and whether the rail applies now: collapsed AND wide
 * enough. A tablet turned to portrait gets its labelled drawer back without
 * forgetting the choice.
 */
export function useSidebarRail(): { collapsed: boolean; rail: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [desktop, setDesktop] = useState(desktopMatches);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(SHELL_DESKTOP_QUERY);
    const follow = () => setDesktop(query.matches);
    follow();
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);

  const toggle = useCallback(() => {
    setCollapsed(current => {
      writeSidebarCollapsed(!current);
      return !current;
    });
  }, []);

  return { collapsed, rail: collapsed && desktop, toggle };
}

/** A rail tooltip opens away from the sidebar, which sits at the inline start. */
export function useRailTipSide(): 'left' | 'right' {
  return useDirection() === 'rtl' ? 'left' : 'right';
}

/**
 * An item's name beside it while the rail hides the label: the spec's
 * `.sb-tip`, 10 px beside the item and on the left in RTL, portaled out of the
 * sidebar so its backdrop filter cannot trap it. Outside the rail it never
 * opens, so a labelled sidebar shows no tooltip repeating its own text. The
 * tree is the same either way: switching the rail must not remount the item,
 * or the toggle would lose keyboard focus the moment it is pressed.
 */
export function RailTip({ rail, label, children }: { rail: boolean; label: string; children: ReactElement }) {
  const side = useRailTipSide();
  const [open, setOpen] = useState(false);
  return (
    <TooltipPrimitive.Root open={rail && open} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={10}
          collisionPadding={8}
          className="glass-tip pointer-events-none z-[60] whitespace-nowrap rounded-[8px] px-[9px] py-[5px] font-ui text-[12.5px] font-[550] text-fg motion-safe:animate-ui-fade-in"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * One tooltip provider around a whole sidebar, so a sweep down the rail opens
 * each next name at once instead of restarting the delay per item. Every
 * `RailTip` must sit inside one.
 */
export function RailTipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={100} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * Collapse or expand the sidebar. Drawn only from `lg` up, where the rail
 * exists; the drawer below has its own menu button. The panel icon mirrors in
 * RTL, as the spec's `.sb-toggle svg` does.
 */
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const label = collapsed ? t('ui.shell.expandSidebar') : t('ui.shell.collapseSidebar');
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <RailTip rail={collapsed} label={label}>
      <button
        type="button"
        onClick={onToggle}
        aria-controls={SHELL_SIDEBAR_ID}
        aria-expanded={!collapsed}
        aria-label={label}
        className="hidden size-8 shrink-0 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus lg:inline-flex"
      >
        <Icon size={18} aria-hidden className="rtl:-scale-x-100" />
      </button>
    </RailTip>
  );
}
