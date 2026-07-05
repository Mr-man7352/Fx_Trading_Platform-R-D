/**
 * @fx/ui — design system (FE-010) + trading compositions (FE-011).
 * Consumed as TS source via Next `transpilePackages`; theme tokens live in
 * `@fx/ui/theme.css` (import alongside `tailwindcss` in the app stylesheet).
 */

// FE-010 — utilities + shadcn-style primitives (vendored)
export { cn } from './lib/cn';
export { Button, buttonVariants, type ButtonProps } from './components/button';
export { Badge, badgeVariants, type BadgeProps } from './components/badge';
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './components/card';
export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './components/dialog';
export { Input } from './components/input';
export { Label } from './components/label';
export { Separator } from './components/separator';
export { Skeleton } from './components/skeleton';
export { Alert, AlertTitle, AlertDescription, alertVariants, type AlertProps } from './components/alert';

// FE-011 — trading compositions
export { AppShell, type AppShellProps } from './trading/app-shell';
export { ModeBadge, MODE_BADGE_STYLES, type ModeBadgeProps } from './trading/mode-badge';
export {
  PnLTile,
  formatSigned,
  pnlDirection,
  type PnLTileProps,
} from './trading/pnl-tile';
export {
  AgentVoteCard,
  AGENT_VOTE_STYLES,
  type AgentVote,
  type AgentVoteCardProps,
} from './trading/agent-vote-card';
export { KillSwitchButton, type KillSwitchButtonProps } from './trading/kill-switch-button';

// FE-110 (Phase-1 part) — compliance banner
export { DisclaimerBanner, DISCLAIMER_TEXT } from './trading/disclaimer-banner';
