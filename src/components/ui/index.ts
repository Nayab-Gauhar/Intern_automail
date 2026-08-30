/**
 * The design-system public surface. Consumers do one import:
 *
 *   import { Button, Field, Input, StatusBadge } from '@/components/ui'
 *
 * Everything here is pure presentation: no @/modules, no @/server, no db (lint-enforced
 * in eslint.config.mjs). Domain -> presentation mapping (status maps, stat cards, data
 * tables) belongs in src/components/patterns/.
 *
 * NOT YET BUILT, deliberately — each needs a package that is not installed, and a
 * half-working focus trap or an unpositioned popover is worse than its absence:
 *   Dialog, Sheet/Drawer, DropdownMenu, Tooltip, Popover  -> need @radix-ui/react-*
 *   Toast                                                 -> needs sonner (or the
 *                                                            ~120-line in-house
 *                                                            aria-live fallback)
 * Until they land: StatusBadge's caveat uses `title` + sr-only text, Select is a native
 * <select>, and there is no toast — Server Action failures render via <FormMessage>.
 */

export { Button, buttonClasses } from './button'
export type { ButtonProps, ButtonSize, ButtonVariant } from './button'

export { Badge, StatusBadge } from './badge'
export type { BadgeProps, StatusBadgeProps, StatusTone } from './badge'

export {
  Card,
  cardClasses,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card'
export type {
  CardFooterProps,
  CardHeaderProps,
  CardOptions,
  CardProps,
  CardTitleProps,
} from './card'

export { Checkbox, CheckboxRow } from './checkbox'
export type { CheckboxProps, CheckboxRowProps } from './checkbox'

export { EmptyState } from './empty-state'
export type { EmptyStateKind, EmptyStateProps } from './empty-state'

export { ErrorInline, ErrorState } from './error-state'
export type { ErrorInlineProps, ErrorStateProps } from './error-state'

export { Field, FormMessage } from './field'
export type { FieldControlProps, FieldProps, FormMessageProps } from './field'

export { Input, InputAffix, InputGroup, inputBaseClasses } from './input'
export type { InputAffixProps, InputGroupProps, InputProps } from './input'

export { KeyboardHint } from './keyboard-hint'
export type { KeyboardHintProps } from './keyboard-hint'

export { Label } from './label'
export type { LabelProps } from './label'

export { LoadingInline, LoadingState, TableLoadingRows } from './loading-state'
export type { LoadingInlineProps, LoadingStateProps, TableLoadingRowsProps } from './loading-state'

export { Panel, PanelBody, PanelFooter, PanelHeader, PanelTitle } from './panel'
export type { PanelProps, PanelTitleProps } from './panel'

export { Select } from './select'
export type { SelectProps } from './select'

export { Separator } from './separator'
export type { SeparatorProps } from './separator'

export { Skeleton, SkeletonGroup, SkeletonText } from './skeleton'
export type { SkeletonGroupProps, SkeletonProps, SkeletonTextProps } from './skeleton'

export { Spinner } from './spinner'
export type { SpinnerProps } from './spinner'

export { Switch, SwitchRow } from './switch'
export type { SwitchProps, SwitchRowProps } from './switch'

export {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableEmptyCellValue,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  TableRowActionsCell,
  TableSortButton,
  tableSortButtonClasses,
} from './table'
export type {
  SortDirection,
  TableCellProps,
  TableContainerProps,
  TableDensity,
  TableHeadProps,
  TableProps,
  TableRowProps,
  TableSortButtonProps,
} from './table'

export { Tabs, TabsList, TabsPanel, TabsTrigger, tabTriggerClasses, tabsListClasses } from './tabs'
export type { TabsListProps, TabsPanelProps, TabsProps, TabsTriggerProps } from './tabs'

export { Avatar, AvatarGroup, initialsFrom } from './avatar'
export type { AvatarGroupProps, AvatarProps, AvatarSize } from './avatar'

export { CharacterCount, Textarea } from './textarea'
export type { CharacterCountProps, TextareaProps } from './textarea'
