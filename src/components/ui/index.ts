/**
 * The El-Professor design system (Phase 2).
 *
 * Tokens live in src/index.css and are mapped in tailwind.config.js; the
 * preview at /design-preview shows every component in use. Of the existing
 * screens only the Gehaltsquittung dialog and receipt list (plan 4.3a) use it.
 * Phase 5 moves the others across in batches.
 */
export { AppShell, type AppShellNavGroup, type AppShellNavItem, type AppShellProps } from './AppShell';
export { Badge, badgeVariants, type BadgeProps } from './Badge';
export { Button, buttonVariants, type ButtonProps } from './Button';
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './Card';
export { cn } from './cn';
export {
  DataTable,
  type DataTableColumn,
  type DataTableColumnKind,
  type DataTableProps,
  type DataTableSort,
} from './DataTable';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './Dialog';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Field, useFieldControlProps, type FieldProps } from './Field';
export { formatDate, formatEuro, formatEuroCents, formatNumber, formatPercent } from './format';
export { Input, type InputProps } from './Input';
export { KpiCard, type KpiCardProps, type KpiTrend } from './KpiCard';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './Select';
export { Skeleton } from './Skeleton';
export { sortRows, type SortDirection, type SortValue } from './sortRows';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs';
export { Tooltip, type TooltipProps } from './Tooltip';
