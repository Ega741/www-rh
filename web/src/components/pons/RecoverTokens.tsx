/**
 * Creator tool "Recover tokens" (SPEC §9.7, Pons mode): `registry.recoverAccountTokens(token, erc20)`
 * moves the mind account's whole balance of an ERC-20 (e.g. memecoin paid out by a Pons rescue) to
 * the creator. ETH never leaves this way. Shows the account's balance of the chosen token first.
 *
 * @module components/pons/RecoverTokens
 */
import { useState } from 'react';
import { erc20Abi, formatUnits, type Address } from 'viem';
import { useReadContracts, useWriteContract } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../../config';
import { formatDecimal } from '../../format';
import { useTxFlow } from '../../hooks/useTxFlow';
import { canRecover, checkRecoverToken, ponsMindRegistryAbi } from '../../lib/pons';
import type { MindDetail } from '../../lib/types';
import { ChainGuard } from '../ChainGuard';
import { AddressLink, TxStatus } from '../common';

/** See module docs. */
export function RecoverTokens({ mind, account, onChanged }: { mind: MindDetail; account: Address; onChanged: () => void }) {
  const write = useWriteContract();
  const [input, setInput] = useState('');
  const check = checkRecoverToken(input);
  const erc20 = check.ok ? check.erc20 : undefined;
  const reads = useReadContracts({
    contracts: [
      { address: erc20, abi: erc20Abi, functionName: 'balanceOf', args: [account], chainId: TARGET_CHAIN.id },
      { address: erc20, abi: erc20Abi, functionName: 'symbol', chainId: TARGET_CHAIN.id },
      { address: erc20, abi: erc20Abi, functionName: 'decimals', chainId: TARGET_CHAIN.id },
    ],
    query: { enabled: erc20 !== undefined, refetchInterval: 15_000 },
  });
  const tx = useTxFlow({
    onConfirmed: () => {
      void reads.refetch();
      onChanged();
    },
  });
  const balance = reads.data?.[0]?.status === 'success' ? reads.data[0].result : reads.isError || reads.data !== undefined ? null : undefined;
  const symbol = reads.data?.[1]?.status === 'success' ? reads.data[1].result : null;
  const decimals = reads.data?.[2]?.status === 'success' ? reads.data[2].result : 18;
  const isMindToken = erc20 !== undefined && erc20 === mind.token.toLowerCase();

  return (
    <div className="space-y-2">
      <p className="label">recover tokens</p>
      <p className="text-[11px] text-dim">
        Moves the mind account&apos;s whole balance of an ERC-20 (for example ${mind.symbol} paid out by a Pons rescue) to your wallet. ETH never leaves
        this way: it only pays for compute.
      </p>
      <div className="flex gap-2">
        <input
          className={`field flex-1 py-1 ${check.ok === false && check.message !== null ? 'field-error' : ''}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ERC-20 address 0x…"
          spellCheck={false}
          disabled={tx.busy}
        />
        <button type="button" className="btn btn-sm" onClick={() => setInput(mind.token)} disabled={tx.busy}>
          ${mind.symbol}
        </button>
      </div>
      {check.ok === false && check.message !== null && <p className="text-[12px] text-danger">{check.message}</p>}
      {erc20 !== undefined && (
        <p className="text-[12px] text-dim">
          account <AddressLink address={account} /> holds{' '}
          {balance === undefined ? '…' : balance === null ? 'an unknown amount' : `${formatDecimal(formatUnits(balance, decimals))} ${symbol ?? (isMindToken ? mind.symbol : 'tokens')}`}
          {balance === null && ' (not an ERC-20?)'}
        </p>
      )}
      <ChainGuard action="recover" compact>
        <button
          type="button"
          className="btn btn-sm w-full"
          disabled={erc20 === undefined || !canRecover(balance) || tx.busy || REGISTRY_ADDRESS === null}
          onClick={() => {
            if (erc20 === undefined) return;
            void tx.run(() =>
              write.mutateAsync({
                address: REGISTRY_ADDRESS as Address,
                abi: ponsMindRegistryAbi,
                functionName: 'recoverAccountTokens',
                args: [mind.token, erc20],
                chainId: TARGET_CHAIN.id,
              }),
            );
          }}
        >
          {tx.busy ? 'Recovering…' : balance === 0n ? 'Nothing to recover' : 'Recover to my wallet'}
        </button>
      </ChainGuard>
      <TxStatus tx={tx} labels={{ confirmed: 'Recovered to your wallet.' }} />
    </div>
  );
}
