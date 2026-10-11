/** Amount input with a USD ↔ token toggle and the converted value shown underneath. */
import type { AmountMode } from '../lib/amounts.js';
import { Field, Input, Segmented } from './ui.jsx';

/** Props of {@link AmountInput}. */
export interface AmountInputProps {
  id: string;
  label: string;
  value: string;
  mode: AmountMode;
  symbol: string;
  onChange(value: string): void;
  onModeChange(mode: AmountMode): void;
  /** Validation error of the raw input. */
  error?: string | undefined;
  /** Converted amount text (e.g. `≈ 1,000 BEAGLE`). */
  converted?: string | undefined;
  disabled?: boolean;
  placeholder?: string;
}

/** The input. */
export function AmountInput(p: AmountInputProps) {
  return (
    <Field label={p.label} error={p.error} hint={p.converted} htmlFor={p.id}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Input
            id={p.id}
            mono
            inputMode="decimal"
            autoComplete="off"
            placeholder={p.placeholder ?? (p.mode === 'usd' ? '10.00' : '1000')}
            value={p.value}
            disabled={p.disabled ?? false}
            onChange={(e) => p.onChange(e.target.value)}
            className="pr-16"
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-xs text-faint">{p.mode === 'usd' ? 'USD' : p.symbol}</span>
        </div>
        <Segmented
          ariaLabel="Amount unit"
          value={p.mode}
          onChange={p.onModeChange}
          options={[
            { value: 'usd', label: 'USD' },
            { value: 'token', label: p.symbol },
          ]}
        />
      </div>
    </Field>
  );
}
