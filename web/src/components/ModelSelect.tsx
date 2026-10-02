/**
 * Model picker for the create / reconfigure flows: models from `GET /api/models` (falling back
 * to the `@www-rh/shared` catalog), with per-MTok price hints and the relative cost vs. the
 * cheapest model.
 *
 * @module components/ModelSelect
 */
import type { ModelInfo } from '../lib/types';

/** Blended cost per MTok used for the relative-cost hint (typical tick: mostly cached input). */
function blendedUsdPerMTok(m: ModelInfo): number {
  return m.cacheReadUsdPerMTok * 0.7 + m.inputUsdPerMTok * 0.15 + m.outputUsdPerMTok * 0.15;
}

/** Props of {@link ModelSelect}. */
export interface ModelSelectProps {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
  source?: 'runner' | 'catalog';
  disabled?: boolean;
}

/** Radio-card list of models. */
export function ModelSelect({ models, value, onChange, source, disabled = false }: ModelSelectProps) {
  if (models.length === 0) return <p className="text-dim">Loading models…</p>;
  const cheapest = Math.min(...models.map(blendedUsdPerMTok));
  return (
    <div className="space-y-1.5" role="radiogroup" aria-label="Model">
      {models.map((m) => {
        const selected = m.id === value;
        const ratio = cheapest > 0 ? blendedUsdPerMTok(m) / cheapest : 1;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(m.id)}
            className={`flex w-full items-start gap-3 rounded border px-3 py-2 text-left transition-colors ${
              selected ? 'border-acid/70 bg-acid/5' : 'border-line-2 hover:border-mute'
            }`}
          >
            <span className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full border ${selected ? 'border-acid bg-acid' : 'border-mute'}`} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className={selected ? 'text-acid' : 'text-fg'}>
                  {m.label}
                  {m.isDefault && <span className="ml-2 text-[11px] text-dim">default</span>}
                </span>
                <span className="text-[11px] text-dim tabular-nums">
                  ${m.inputUsdPerMTok} in / ${m.outputUsdPerMTok} out · ${m.cacheReadUsdPerMTok} cached per MTok
                </span>
              </span>
              <span className="block text-[12px] text-dim">{m.description}</span>
              <span className="block text-[11px] text-mute">
                {ratio <= 1.05 ? 'cheapest: the vault lasts longest' : `≈ ${ratio.toFixed(1)}× the burn of the cheapest model`}
              </span>
            </span>
          </button>
        );
      })}
      {source === 'catalog' && (
        <p className="text-[11px] text-mute">Prices from the built-in catalog (the runner did not answer /api/models).</p>
      )}
    </div>
  );
}
