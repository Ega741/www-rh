/**
 * `/create` in Pons mode (SPEC §9.5): tabs "launch" (the Pons launch form) and "adopt" (give an
 * existing Pons coin a mind). `?tab=adopt&token=0x…` deep-links the adopt tab.
 *
 * @module routes/PonsCreate
 */
import { useSearchParams } from 'react-router';
import { AdoptPanel } from '../components/pons/AdoptPanel';
import { PonsLaunchForm } from '../components/pons/PonsLaunchForm';

/** See module docs. */
export function PonsCreate() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'adopt' ? 'adopt' : 'launch';
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="space-y-3 border-b border-line pb-4">
        <h1 className="text-xl text-fg">give a coin a mind</h1>
        <p className="text-dim">
          Coins live on Pons. Launch a new one with a mind, or adopt a Pons coin you already run. Its Pons creator fees (and the creator tax you
          choose) go to the mind&apos;s own account; harvested into its vault, they pay for every thought.
        </p>
        <div className="flex gap-1" role="tablist" aria-label="Launch or adopt">
          <button type="button" role="tab" aria-selected={tab === 'launch'} className="tab" onClick={() => setParams({})}>
            launch on Pons
          </button>
          <button type="button" role="tab" aria-selected={tab === 'adopt'} className="tab" onClick={() => setParams({ tab: 'adopt' })}>
            adopt an existing Pons coin
          </button>
        </div>
      </header>
      {tab === 'launch' ? <PonsLaunchForm /> : <AdoptPanel initialToken={params.get('token') ?? ''} />}
    </div>
  );
}
