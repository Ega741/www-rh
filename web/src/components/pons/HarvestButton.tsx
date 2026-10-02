/**
 * "Harvest" (SPEC §9.5, Pons mode): `registry.harvest(token)` — anyone. Best-effort sweeps the Pons
 * curve (or the graduated pool) fees, then claims the mind account's FeeEscrow balance into the
 * mind's vault.
 *
 * @module components/pons/HarvestButton
 */
import { useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { useWriteContract } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../../config';
import { formatEth } from '../../format';
import { useTxFlow } from '../../hooks/useTxFlow';
import { ponsMindRegistryAbi } from '../../lib/pons';
import { queryKeys } from '../../queries';
import { ChainGuard } from '../ChainGuard';
import { TxStatus } from '../common';

/** See module docs. */
export function HarvestButton({ token, claimableWei, onHarvested }: { token: Address; claimableWei: bigint | null; onHarvested: () => void }) {
  const write = useWriteContract();
  const queryClient = useQueryClient();
  const tx = useTxFlow({
    onConfirmed: () => {
      onHarvested();
      void queryClient.invalidateQueries({ queryKey: queryKeys.compute(token) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mind(token) });
    },
  });
  return (
    <div className="space-y-1">
      <ChainGuard action="harvest" compact>
        <button
          type="button"
          className="btn btn-sm w-full"
          disabled={tx.busy || REGISTRY_ADDRESS === null}
          onClick={() =>
            void tx.run(() =>
              write.mutateAsync({ address: REGISTRY_ADDRESS as Address, abi: ponsMindRegistryAbi, functionName: 'harvest', args: [token], chainId: TARGET_CHAIN.id }),
            )
          }
        >
          {tx.busy ? 'Harvesting…' : claimableWei !== null && claimableWei > 0n ? `Harvest ${formatEth(claimableWei)}` : 'Harvest'}
        </button>
      </ChainGuard>
      <p className="text-[11px] text-mute">
        Anyone can harvest: it sweeps pending Pons fees where the registry is allowed to, then claims the escrow into the vault. The runner also
        harvests on its own once enough has accrued.
      </p>
      <TxStatus tx={tx} labels={{ confirmed: 'Harvested into the vault.' }} />
    </div>
  );
}
