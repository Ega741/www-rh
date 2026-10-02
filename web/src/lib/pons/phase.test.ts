import { describe, expect, it } from 'vitest';
import { PonsGraduationPhase } from './abi';
import { factoryPhaseName, ponsPhase, ponsPhaseLabel } from './phase';
import { snipeWindow } from './snipe';

describe('Pons phases (SPEC §9.3/§9.5)', () => {
  it('maps the factory phase and curve flags onto bonding / complete / graduated', () => {
    expect(ponsPhase({ factoryPhase: PonsGraduationPhase.NotGraduated, graduated: false, readyToGraduate: false })).toBe('bonding');
    expect(ponsPhase({ factoryPhase: PonsGraduationPhase.NotGraduated, graduated: false, readyToGraduate: true })).toBe('complete');
    expect(ponsPhase({ factoryPhase: PonsGraduationPhase.Swept, graduated: true, readyToGraduate: false })).toBe('complete');
    expect(ponsPhase({ factoryPhase: PonsGraduationPhase.PoolCreated, graduated: true, readyToGraduate: false })).toBe('graduated');
    expect(ponsPhase({ factoryPhase: PonsGraduationPhase.Rescued, graduated: true, readyToGraduate: false })).toBe('graduated');
    expect(ponsPhase({ factoryPhase: null, graduated: true, readyToGraduate: null })).toBe('complete');
    expect(ponsPhase({ factoryPhase: null, graduated: null, readyToGraduate: null })).toBe('bonding');
  });

  it('labels complete as graduating', () => {
    expect(ponsPhaseLabel('bonding')).toBe('bonding');
    expect(ponsPhaseLabel('complete')).toBe('graduating');
    expect(ponsPhaseLabel('graduated')).toBe('graduated');
    expect(factoryPhaseName(1)).toMatch(/swept/);
    expect(factoryPhaseName(9)).toMatch(/unknown/);
  });
});

describe('snipe-tax window', () => {
  const launchedAt = 1_700_000_000;
  it('is open for snipeTaxSeconds after launch and counts down in whole seconds', () => {
    expect(snipeWindow(launchedAt, 15, launchedAt * 1000)).toEqual({ active: true, remainingSeconds: 15, endsAt: launchedAt + 15 });
    expect(snipeWindow(launchedAt, 15, launchedAt * 1000 + 14_100)).toMatchObject({ active: true, remainingSeconds: 1 });
    expect(snipeWindow(launchedAt, 15, (launchedAt + 15) * 1000)).toMatchObject({ active: false, remainingSeconds: 0 });
  });

  it('is closed when the launch time is unknown or the window is zero', () => {
    expect(snipeWindow(null, 15, 0)).toEqual({ active: false, remainingSeconds: 0, endsAt: null });
    expect(snipeWindow(launchedAt, 0, launchedAt * 1000).active).toBe(false);
  });
});
