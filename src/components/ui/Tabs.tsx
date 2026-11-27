import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from './cn';

type TabsVariant = 'underline' | 'segmented';

const TabsVariantContext = createContext<TabsVariant>('underline');

export const Tabs = TabsPrimitive.Root;

const listClasses: Record<TabsVariant, string> = {
  // The rule is an inset shadow, not a border, so the list can scroll
  // sideways on a phone without clipping the active tab's underline.
  underline: 'gap-1 shadow-[inset_0_-1px_0_rgb(var(--line))]',
  segmented: 'gap-0.5 rounded-control border border-edge bg-sunken p-[3px]',
};

// Taller on touch screens, like Button.
const triggerClasses: Record<TabsVariant, string> = {
  underline:
    'relative h-10 px-3 after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent data-[state=active]:text-fg data-[state=active]:after:bg-brand [@media(pointer:coarse)]:h-11',
  segmented:
    'h-7 rounded-[7px] px-3 text-[12.5px] data-[state=active]:bg-raised data-[state=active]:text-fg data-[state=active]:shadow-segment [@media(pointer:coarse)]:h-10',
};

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsVariant }
>(({ className, variant = 'underline', ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.List
      ref={ref}
      className={cn('inline-flex max-w-full items-center overflow-x-auto font-ui', listClasses[variant], className)}
      {...props}
    />
  </TabsVariantContext.Provider>
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-[13.5px] font-[550] text-fg-subtle transition-colors hover:text-fg',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
        'disabled:pointer-events-none disabled:opacity-50',
        triggerClasses[variant],
        className,
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = 'TabsContent';
