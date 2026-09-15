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
  segmented: 'gap-0.5 rounded-control bg-sunken p-0.5',
};

// Taller on touch screens, like Button.
const triggerClasses: Record<TabsVariant, string> = {
  underline:
    'h-10 border-b-2 border-transparent px-3 data-[state=active]:border-brand data-[state=active]:text-fg [@media(pointer:coarse)]:h-11',
  segmented:
    'h-8 rounded-[calc(var(--radius-control)-2px)] px-3 data-[state=active]:bg-raised data-[state=active]:text-fg data-[state=active]:shadow-raised [@media(pointer:coarse)]:h-10',
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
        'inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-sm font-medium text-fg-muted transition-colors hover:text-fg',
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
