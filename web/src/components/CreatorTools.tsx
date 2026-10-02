/**
 * Creator tools (W3), shown only when the connected wallet is the coin's creator:
 * pause / resume the mind (`setCreatorPaused`) and change its model or persona
 * (`setMindConfig` with freshly published metadata), on the launchpad (curve mode) or the
 * registry (Pons mode). Pons mode adds "Leave" (`registry.leave`, SPEC §9.5). There is no
 * withdraw: vault ETH can only pay for compute (D4).
 *
 * @module components/CreatorTools
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Address } from 'viem';
import { useWriteContract } from 'wagmi';
import { CORE_ADDRESS, TARGET_CHAIN, VENUE } from '../config';
import { useTxFlow } from '../hooks/useTxFlow';
import { mindLaunchpadAbi as launchpadAbi } from '@www-rh/shared';
import { describeError } from '../lib/errors';
import { METADATA_LIMITS, buildMetadata, modelHashOf, personaHashOf, validateDraft, type MetadataDraft } from '../lib/metadata';
import { publishMetadata } from '../lib/publish';
import type { MindDetail, PonsLive } from '../lib/types';
import { queryKeys, useModels } from '../queries';
import { ChainGuard } from './ChainGuard';
import { ModelSelect } from './ModelSelect';
import { Panel, TxStatus } from './common';
import { LeaveMind } from './pons/LeaveMind';

/** Props of {@link CreatorTools}. */
export interface CreatorToolsProps {
  mind: MindDetail;
  /** Catalog id of the current model, if known. */
  currentModel: string | null;
  onChanged: () => void;
  /** Live Pons state (Pons mode), for the "Leave" tool. */
  ponsLive?: PonsLive | null;
}

/** See module docs. */
export function CreatorTools({ mind, currentModel, onChanged, ponsLive = null }: CreatorToolsProps) {
  const queryClient = useQueryClient();
  const models = useModels();
  const write = useWriteContract();
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(currentModel ?? '');
  const [persona, setPersona] = useState(mind.persona ?? '');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const paused = mind.status === 'paused';

  const refresh = () => {
    onChanged();
    void queryClient.invalidateQueries({ queryKey: queryKeys.mind(mind.token) });
  };
  const pauseTx = useTxFlow({ onConfirmed: refresh });
  const configTx = useTxFlow({
    onConfirmed: () => {
      setEditing(false);
      refresh();
    },
  });

  const draft: MetadataDraft = {
    name: mind.name,
    symbol: mind.symbol,
    description: mind.description ?? '',
    image: mind.image ?? '',
    persona,
    model,
    links: { x: mind.links?.x ?? '', website: mind.links?.website ?? '', telegram: mind.links?.telegram ?? '' },
  };
  const errors = validateDraft(draft);
  const blocking = errors.persona ?? errors.model ?? errors.schema ?? errors.image ?? errors.links ?? null;
  const unchanged = model === currentModel && mind.persona !== null && personaHashOf(persona.trim()) === mind.personaHash;

  async function saveConfig() {
    if (CORE_ADDRESS === null || blocking !== null) return;
    setPublishError(null);
    setPublishing(true);
    const meta = buildMetadata(draft);
    try {
      const pub = await publishMetadata(meta);
      setPublishing(false);
      await configTx.run(() =>
        write.mutateAsync({
          address: CORE_ADDRESS as Address,
          abi: launchpadAbi,
          functionName: 'setMindConfig',
          args: [mind.token, modelHashOf(meta.model), pub.personaHash, pub.uri],
          chainId: TARGET_CHAIN.id,
        }),
      );
    } catch (e) {
      setPublishing(false);
      setPublishError(describeError(e));
    }
  }

  return (
    <Panel title="creator tools" right={<span className="normal-case tracking-normal text-acid">you created this coin</span>}>
      <div className="space-y-4 p-3">
        <div className="space-y-1.5">
          <p className="text-[12px] text-dim">
            {paused
              ? 'The mind is paused: it does not think and draws no compute. Resume it to let the runner schedule it again.'
              : 'Pausing stops the mind from thinking and drawing compute. The vault stays locked for compute only; nobody can withdraw it.'}
          </p>
          <ChainGuard action="manage the mind" compact>
            <button
              type="button"
              className={`btn btn-sm w-full ${paused ? 'btn-primary' : ''}`}
              disabled={pauseTx.busy}
              onClick={() =>
                void pauseTx.run(() =>
                  write.mutateAsync({
                    address: CORE_ADDRESS as Address,
                    abi: launchpadAbi,
                    functionName: 'setCreatorPaused',
                    args: [mind.token, !paused],
                    chainId: TARGET_CHAIN.id,
                  }),
                )
              }
            >
              {pauseTx.busy ? 'Sending…' : paused ? 'Resume the mind' : 'Pause the mind'}
            </button>
          </ChainGuard>
          <TxStatus tx={pauseTx} labels={{ confirmed: paused ? 'Paused.' : 'Updated.' }} />
        </div>

        <div className="space-y-2 border-t border-line pt-3">
          {!editing ? (
            <button type="button" className="btn btn-sm w-full" onClick={() => setEditing(true)}>
              Change model or persona
            </button>
          ) : (
            <>
              <span className="label">model</span>
              <ModelSelect models={models.data?.models ?? []} source={models.data?.source} value={model} onChange={setModel} disabled={configTx.busy || publishing} />
              <span className="label mt-2">persona</span>
              <textarea className="field min-h-32" value={persona} onChange={(e) => setPersona(e.target.value)} disabled={configTx.busy || publishing} />
              <p className="text-[11px] text-mute">
                {persona.trim().length}/{METADATA_LIMITS.personaChars}. New metadata is published (name, ticker, image and links stay the same) and its
                hashes are written on-chain with setMindConfig.
              </p>
              {blocking !== null && <p className="text-[12px] text-danger">{blocking}</p>}
              {publishError !== null && <p className="text-[12px] text-danger">{publishError}</p>}
              <div className="flex gap-2">
                <button type="button" className="btn btn-sm flex-1" onClick={() => setEditing(false)} disabled={configTx.busy || publishing}>
                  cancel
                </button>
                <div className="flex-1">
                  <ChainGuard action="save" compact>
                    <button type="button" className="btn btn-primary btn-sm w-full" disabled={blocking !== null || unchanged || configTx.busy || publishing} onClick={() => void saveConfig()}>
                      {publishing ? 'Publishing…' : configTx.busy ? 'Saving…' : 'Save'}
                    </button>
                  </ChainGuard>
                </div>
              </div>
              <TxStatus tx={configTx} labels={{ confirmed: 'Saved. The mind uses it from its next thought.' }} />
            </>
          )}
        </div>
        {VENUE === 'pons' && mind.pons !== null && <LeaveMind mind={mind} live={ponsLive} onChanged={refresh} />}
      </div>
    </Panel>
  );
}
