/** Banner shown when the wallet is on a chain other than the one this build targets. */
import { config } from '../config.js';
import { useChainGuard } from '../hooks/useChainGuard.js';
import { Button, Note } from './ui.jsx';

/** Prompts a switch (adds the chain via EIP-3085 when the wallet lacks it). */
export function ChainGuardBanner() {
  const guard = useChainGuard();
  if (!guard.wrongChain) return null;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-3">
      <Note
        tone="warn"
        title={`Your wallet is on chain ${guard.walletChainId ?? '?'}; this app uses ${config.chain.name} (${config.chainId}).`}
        actions={
          <Button variant="primary" size="sm" busy={guard.switching} onClick={() => void guard.switchToAppChain().catch(() => undefined)}>
            Switch to {config.chain.name}
          </Button>
        }
      >
        {guard.error ?? 'On-chain actions are disabled until the wallet is on the right chain. Reads still work.'}
      </Note>
    </div>
  );
}
