import { TradingModeSchema } from "@fx/types";
import {
  AgentVoteCard,
  AppShell,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DisclaimerBanner,
  ModeBadge,
  PnLTile,
} from "@fx/ui";
import { KillSwitch } from "./kill-switch";

/**
 * Step 1.7 — placeholder operator home exercising the FE-010/FE-011 design
 * system with fixture data. Live tiles, charts, and the debate viewer land in
 * Phase 5 (FE-040…131).
 */
export default function DashboardPage() {
  const mode = TradingModeSchema.catch("paper").parse(process.env.TRADING_MODE);
  console.log("DashboardPage", { mode });

  return (
    <AppShell
      brand={
        <span className="font-mono text-sm font-bold tracking-wider">
          FX PLATFORM
        </span>
      }
      headerRight={
        <>
          <ModeBadge mode={mode} />
          <div className="hidden md:block">
            <KillSwitch />
          </div>
        </>
      }
      banner={<DisclaimerBanner />}
      mobileFooter={<KillSwitch compact />}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <PnLTile label="Unrealized P&L" value={342.18} changePct={1.2} />
        <PnLTile label="Realized (today)" value={-87.3} changePct={-0.4} />
        <PnLTile label="Realized (week)" value={0} />
        <PnLTile label="Equity" value={28451.02} stale />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Latest debate — fixture</CardTitle>
          <CardDescription>
            Multi-agent confirm/veto arrives in Phase 3; this exercises the
            FE-011 compositions.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <AgentVoteCard
            agentName="Technical Analyst"
            vote="buy"
            confidence={0.74}
            modelId="model@snapshot"
            summary="H1 momentum aligned with H4 trend; pullback to demand."
          />
          <AgentVoteCard
            agentName="Macro Analyst"
            vote="hold"
            confidence={0.55}
            modelId="model@snapshot"
            summary="FOMC minutes in 6h — elevated event risk."
          />
          <AgentVoteCard
            agentName="Risk PM"
            vote="veto"
            confidence={0.81}
            modelId="model@snapshot"
            summary="Correlation cluster already at exposure cap."
          />
        </CardContent>
      </Card>
    </AppShell>
  );
}
