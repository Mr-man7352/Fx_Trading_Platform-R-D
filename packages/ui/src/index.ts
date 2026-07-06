/**
 * @fx/ui — design system (FE-010) + trading compositions (FE-011).
 * Consumed as TS source via Next `transpilePackages`; theme tokens live in
 * `@fx/ui/theme.css` (import alongside `tailwindcss` in the app stylesheet).
 */

export {
  Alert,
  AlertDescription,
  type AlertProps,
  AlertTitle,
  alertVariants,
} from './components/alert';
export { Badge, type BadgeProps, badgeVariants } from './components/badge';
export { Button, type ButtonProps, buttonVariants } from './components/button';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './components/card';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './components/dialog';
export { Input } from './components/input';
export { Label } from './components/label';
export { Separator } from './components/separator';
export { Skeleton } from './components/skeleton';
// FE-010 — utilities + shadcn-style primitives (vendored)
export { cn } from './lib/cn';
export {
  AGENT_VOTE_STYLES,
  type AgentVote,
  AgentVoteCard,
  type AgentVoteCardProps,
} from './trading/agent-vote-card';
// FE-011 — trading compositions
export { AppShell, type AppShellProps } from './trading/app-shell';
// FE-110 (Phase-1 part) — compliance banner
export { DISCLAIMER_TEXT, DisclaimerBanner } from './trading/disclaimer-banner';
export { KillSwitchButton, type KillSwitchButtonProps } from './trading/kill-switch-button';
export { MODE_BADGE_STYLES, ModeBadge, type ModeBadgeProps } from './trading/mode-badge';
export {
  formatSigned,
  PnLTile,
  type PnLTileProps,
  pnlDirection,
} from './trading/pnl-tile';
