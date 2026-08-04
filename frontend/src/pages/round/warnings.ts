import type { FeeConfig, GuardrailConfig, Market, TradingStyle } from '../../api/types';

export interface WarningInput {
  startingBalanceCents: number;
  profitGoalCents: number;
  markets: Market[];
  tradingStyle: TradingStyle;
  guardrails: GuardrailConfig;
  fees: FeeConfig;
  watchlist: string[];
  checkinCron: string[];
}

/**
 * Pure foot-gun rules for the new-round wizard (spec §6). Warnings never block
 * creation — the operator is allowed to run a doomed experiment on purpose.
 */
export function roundWarnings(input: WarningInput): string[] {
  const warnings: string[] = [];
  const { startingBalanceCents: bankroll, fees, markets, tradingStyle, guardrails } = input;
  const tradesAsx = markets.includes('ASX');

  // A round trip on ASX costs two flat brokerage hits.
  const roundTripCents = fees.asxFlatCents * 2;
  if (tradesAsx && bankroll > 0 && roundTripCents / bankroll >= 0.05) {
    const pct = ((roundTripCents / bankroll) * 100).toFixed(0);
    warnings.push(
      `ASX brokerage costs ${pct}% of the bankroll per round trip ($${(roundTripCents / 100).toFixed(2)} on $${(bankroll / 100).toFixed(2)}). The position has to move that far just to break even.`,
    );
  }

  if (tradesAsx && tradingStyle === 'day' && bankroll < 100_000) {
    warnings.push(
      'Day trading ASX on a small bankroll is the worst fee combination available: flat brokerage on both sides of every trade, several times a day.',
    );
  }

  if (bankroll > 0 && input.profitGoalCents / bankroll >= 5) {
    const multiple = (input.profitGoalCents / bankroll).toFixed(0);
    warnings.push(
      `The profit goal is ${multiple}× the bankroll. That is a long round — expect it to run for months, if it finishes.`,
    );
  }

  if (guardrails.stopLossPct === null && guardrails.maxPositionPct === null && guardrails.drawdownPausePct === null) {
    warnings.push('No guardrails are enabled. Nothing will stop this round losing the whole bankroll.');
  }

  if (guardrails.maxPositionPct !== null && guardrails.maxPositionPct >= 100) {
    warnings.push('Max position size allows the entire bankroll in a single symbol.');
  }

  if (input.watchlist.length === 0) {
    warnings.push('The watchlist is empty, so the agent has nothing to research or trade.');
  }

  if (markets.includes('CRYPTO') && guardrails.stopLossPct === null) {
    warnings.push(
      'Crypto trades 24/7 with no circuit breakers — running without a stop-loss here is riskier than the same setup on ASX/US.',
    );
  }

  if (input.checkinCron.length === 0) {
    warnings.push('No check-in schedule: the agent will never run unless you trigger check-ins manually.');
  }

  return warnings;
}
