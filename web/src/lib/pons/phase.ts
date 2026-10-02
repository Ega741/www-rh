/**
 * Pons graduation phases → the shared `CurvePhaseName` (SPEC §9.3: `Swept` → `complete`,
 * `PoolCreated` / `Rescued` → `graduated`) and the Pons-mode labels (bonding / graduating /
 * graduated, SPEC §9.5).
 *
 * @module lib/pons/phase
 */
import type { CurvePhaseName } from '../types';
import { PonsGraduationPhase } from './abi';

/** On-chain facts that decide the phase. */
export interface PonsPhaseInput {
  /** `factory.getLaunchedToken(token).phase`, when read. */
  factoryPhase: number | null;
  /** `curve.graduated()`, when read. */
  graduated: boolean | null;
  /** `curve.readyToGraduate()` (sellable allocation exhausted, auto-graduation pending), when read. */
  readyToGraduate: boolean | null;
}

/** Maps the Pons state onto `bonding | complete | graduated`. */
export function ponsPhase(input: PonsPhaseInput): CurvePhaseName {
  if (input.factoryPhase === PonsGraduationPhase.PoolCreated || input.factoryPhase === PonsGraduationPhase.Rescued) return 'graduated';
  if (input.factoryPhase === PonsGraduationPhase.Swept) return 'complete';
  if (input.graduated === true || input.readyToGraduate === true) return 'complete';
  return 'bonding';
}

/** Pons-mode phase label: `complete` reads "graduating" (curve swept, Uniswap pool not seeded yet). */
export function ponsPhaseLabel(phase: CurvePhaseName): 'bonding' | 'graduating' | 'graduated' {
  return phase === 'complete' ? 'graduating' : phase;
}

/** Name of a factory `GraduationPhase` value (for the adoption launch record). */
export function factoryPhaseName(phase: number): string {
  switch (phase) {
    case PonsGraduationPhase.NotGraduated:
      return 'bonding (not graduated)';
    case PonsGraduationPhase.Swept:
      return 'graduating (swept)';
    case PonsGraduationPhase.PoolCreated:
      return 'graduated (pool created)';
    case PonsGraduationPhase.Rescued:
      return 'graduated (rescued)';
    default:
      return `unknown (${phase})`;
  }
}
