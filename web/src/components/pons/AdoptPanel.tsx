/**
 * "Adopt an existing Pons coin" (SPEC §9.5): paste a Pons token → its launch record
 * (`factory.getLaunchedToken`) → step 1 `registry.prepareAdoption(token, modelId, personaHash,
 * metadataURI)` (metadata published as in the create flow) → step 2 the current fee recipient calls
 * `factory.transferCreatorFeeRecipient(token, account)` → step 3 `registry.activateAdoption(token)`.
 * The current step is derived from chain state by {@link adoptionStep}, so the flow resumes after a
 * reload or across wallets.
 *
 * @module components/pons/AdoptPanel
 */
import { DEFAULT_MODEL } from '@www-rh/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { erc20Abi, isAddress, zeroAddress, type Address } from 'viem';
import { useConnection, useReadContract, useWriteContract } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../../config';
import { formatBps, formatEth } from '../../format';
import { usePonsFactory } from '../../hooks/usePons';
import { useTxFlow } from '../../hooks/useTxFlow';
import { describeError } from '../../lib/errors';
import { METADATA_LIMITS, PERSONA_PLACEHOLDER, buildMetadata, modelHashOf, validateDraft, type MetadataDraft } from '../../lib/metadata';
import { adoptionStep, adoptionStepNumber, factoryPhaseName, ponsFactoryAbi, ponsMindRegistryAbi, type AdoptionStep } from '../../lib/pons';
import { publishMetadata } from '../../lib/publish';
import { useModels } from '../../queries';
import { ChainGuard } from '../ChainGuard';
import { Field } from '../FormField';
import { ModelSelect } from '../ModelSelect';
import { AddressLink, TxStatus } from '../common';

const STEPS = [
  { n: 1, title: 'Register the mind', who: 'the fee recipient or the deployer', fn: 'registry.prepareAdoption' },
  { n: 2, title: 'Hand the creator fees to the mind account', who: 'the current fee recipient', fn: 'factory.transferCreatorFeeRecipient' },
  { n: 3, title: 'Activate', who: 'anyone', fn: 'registry.activateAdoption' },
] as const;

/** See module docs. */
export function AdoptPanel({ initialToken = '' }: { initialToken?: string }) {
  const [input, setInput] = useState(initialToken);
  const text = input.trim();
  const token = isAddress(text, { strict: false }) ? (text.toLowerCase() as Address) : undefined;
  return (
    <div className="space-y-4">
      <section className="panel space-y-3 p-4">
        <p className="text-dim">
          Already launched a coin on Pons? Give it a mind without relaunching: register it here, point its Pons creator fees at the mind&apos;s own
          account, and the fees pay for its thinking from then on.
        </p>
        <Field label="pons token address" error={text !== '' && token === undefined ? 'Not an address.' : undefined}>
          <input className="field" value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x…" spellCheck={false} />
        </Field>
      </section>
      {token !== undefined && <AdoptToken key={token} token={token} />}
    </div>
  );
}

function AdoptToken({ token }: { token: Address }) {
  const { address } = useConnection();
  const factory = usePonsFactory();
  const queryClient = useQueryClient();
  const reg = { address: REGISTRY_ADDRESS ?? zeroAddress, abi: ponsMindRegistryAbi, chainId: TARGET_CHAIN.id } as const;
  const launch = useReadContract({
    address: factory ?? zeroAddress,
    abi: ponsFactoryAbi,
    functionName: 'getLaunchedToken',
    args: [token],
    chainId: TARGET_CHAIN.id,
    query: { enabled: factory !== null, refetchInterval: 10_000 },
  });
  const mind = useReadContract({ ...reg, functionName: 'ponsMind', args: [token], query: { enabled: REGISTRY_ADDRESS !== null, refetchInterval: 10_000 } });
  const predicted = useReadContract({ ...reg, functionName: 'predictAdoptionAccount', args: [token], query: { enabled: REGISTRY_ADDRESS !== null, staleTime: Infinity } });
  const name = useReadContract({ address: token, abi: erc20Abi, functionName: 'name', chainId: TARGET_CHAIN.id, query: { staleTime: Infinity, retry: false } });
  const symbol = useReadContract({ address: token, abi: erc20Abi, functionName: 'symbol', chainId: TARGET_CHAIN.id, query: { staleTime: Infinity, retry: false } });

  const step: AdoptionStep = adoptionStep({
    wallet: address,
    launch: launch.isError ? null : launch.data,
    mind: mind.isError ? null : mind.data,
    predictedAccount: predicted.data,
  });
  const current = adoptionStepNumber(step);
  const refresh = () => {
    void launch.refetch();
    void mind.refetch();
    void queryClient.invalidateQueries({ queryKey: ['minds'] });
  };

  if (REGISTRY_ADDRESS === null || factory === null) {
    return <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">No PonsMindRegistry / Pons factory is configured for {TARGET_CHAIN.name}.</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        {step.kind === 'loading' && <div className="panel h-40 animate-pulse" aria-busy="true" />}
        {step.kind === 'error' && (
          <p className="rounded border border-danger/40 bg-danger/5 p-2 text-[12px] text-danger">
            Could not read this token from {TARGET_CHAIN.name}: {describeError(launch.error ?? mind.error)}
          </p>
        )}
        {step.kind === 'not-pons' && (
          <p className="rounded border border-amber/40 bg-amber/5 p-3 text-[12px] text-amber">
            The Pons V2 factory has no launch for this address. Only coins launched on Pons V2 can be adopted.
          </p>
        )}
        {(step.kind === 'launched-here' || step.kind === 'adopted') && (
          <section className="panel space-y-2 p-4">
            <p className="text-fg">{step.kind === 'launched-here' ? 'This coin was launched with a mind here.' : 'This coin has a mind.'}</p>
            {step.kind === 'adopted' && !step.receivingFees && (
              <p className="text-[12px] text-amber">Its creator later left: the mind no longer receives the coin&apos;s Pons creator fees.</p>
            )}
            <Link to={`/mind/${token}`} className="btn btn-primary btn-sm hover:no-underline">
              open the mind
            </Link>
          </section>
        )}
        {step.kind === 'connect' && (
          <section className="panel space-y-2 p-4">
            <p className="text-dim">Connect the wallet that receives this coin&apos;s Pons creator fees (or the wallet that launched it).</p>
            <ChainGuard action="adopt">
              <span />
            </ChainGuard>
          </section>
        )}
        {step.kind === 'not-authorized' && (
          <section className="panel space-y-2 p-4 text-[12px]">
            <p className="text-amber">Only this coin&apos;s current Pons creator-fee recipient or its deployer can start the adoption.</p>
            <p className="text-dim">
              fee recipient <AddressLink address={step.recipient} /> · deployer <AddressLink address={step.deployer} />. Switch to one of these wallets.
            </p>
          </section>
        )}
        {step.kind === 'prepare' && <PrepareStep token={token} name={name.data ?? null} symbol={symbol.data ?? null} walletIsRecipient={step.walletIsRecipient} onDone={refresh} />}
        {step.kind === 'transfer' && <TransferStep token={token} factory={factory} account={step.account} recipient={step.recipient} walletIsRecipient={step.walletIsRecipient} onDone={refresh} />}
        {step.kind === 'activate' && <ActivateStep token={token} onDone={refresh} />}
      </div>

      <aside className="space-y-4">
        <section className="panel p-4 text-[12px]">
          <p className="label">launch record</p>
          {launch.data !== undefined && launch.data.exists ? (
            <dl>
              <div className="kv">
                <dt>token</dt>
                <dd>
                  {name.data ?? '…'} <span className="text-dim">${symbol.data ?? '?'}</span>
                </dd>
              </div>
              <div className="kv">
                <dt>curve</dt>
                <dd>
                  <AddressLink address={launch.data.curve} />
                </dd>
              </div>
              <div className="kv">
                <dt>deployer</dt>
                <dd>
                  <AddressLink address={launch.data.deployer} />
                </dd>
              </div>
              <div className="kv">
                <dt>fee recipient</dt>
                <dd>
                  <AddressLink address={launch.data.creatorFeeRecipient} />
                </dd>
              </div>
              <div className="kv">
                <dt>creator tax</dt>
                <dd>{formatBps(launch.data.creatorTaxBps)}</dd>
              </div>
              <div className="kv">
                <dt>graduates at</dt>
                <dd>{formatEth(launch.data.graduationThreshold, { maxFraction: 3 })}</dd>
              </div>
              <div className="kv">
                <dt>phase</dt>
                <dd>{factoryPhaseName(launch.data.phase)}</dd>
              </div>
              {launch.data.pairToken !== zeroAddress && (
                <p className="mt-1 text-amber">This launch trades against an ERC-20, not native ETH; minds are only supported on native-ETH launches.</p>
              )}
            </dl>
          ) : (
            <p className="text-mute">{launch.isPending ? 'reading…' : '—'}</p>
          )}
        </section>
        <ol className="panel space-y-2 p-4 text-[12px]">
          {STEPS.map((s) => (
            <li key={s.n} className={current === s.n ? 'text-fg' : current > s.n ? 'text-acid' : 'text-mute'}>
              <span className="tabular-nums">{current > s.n ? '✓' : `${s.n}.`}</span> {s.title}
              <span className="block pl-4 text-[11px] text-mute">
                {s.fn} · by {s.who}
              </span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

function PrepareStep({ token, name, symbol, walletIsRecipient, onDone }: { token: Address; name: string | null; symbol: string | null; walletIsRecipient: boolean; onDone: () => void }) {
  const models = useModels();
  const write = useWriteContract();
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [persona, setPersona] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState('');
  const [touched, setTouched] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tx = useTxFlow({ onConfirmed: onDone });
  const draft: MetadataDraft = { name: name ?? '', symbol: symbol ?? '', description, image, persona, model, links: { x: '', website: '', telegram: '' } };
  const errors = validateDraft(draft);
  const blocking = errors.name ?? errors.symbol ?? errors.persona ?? errors.model ?? errors.image ?? errors.description ?? errors.schema ?? null;

  async function submit() {
    setTouched(true);
    setError(null);
    if (blocking !== null || REGISTRY_ADDRESS === null) return;
    setPublishing(true);
    try {
      const meta = buildMetadata(draft);
      const pub = await publishMetadata(meta);
      setPublishing(false);
      await tx.run(() =>
        write.mutateAsync({
          address: REGISTRY_ADDRESS as Address,
          abi: ponsMindRegistryAbi,
          functionName: 'prepareAdoption',
          args: [token, modelHashOf(meta.model), pub.personaHash, pub.uri],
          chainId: TARGET_CHAIN.id,
        }),
      );
    } catch (e) {
      setPublishing(false);
      setError(describeError(e));
    }
  }

  return (
    <section className="panel space-y-4 p-4">
      <p className="text-fg">Step 1 · register the mind</p>
      <Field label="mind: model">
        <ModelSelect models={models.data?.models ?? []} source={models.data?.source} value={model} onChange={setModel} disabled={tx.busy || publishing} />
      </Field>
      <Field label="mind: persona" error={touched ? errors.persona : undefined} hint={`${persona.trim().length}/${METADATA_LIMITS.personaChars} characters; its keccak256 goes on-chain as personaHash.`}>
        <textarea className="field min-h-40" value={persona} onChange={(e) => setPersona(e.target.value)} disabled={tx.busy || publishing} placeholder={PERSONA_PLACEHOLDER} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="description" error={touched ? errors.description : undefined} hint="Optional, for the metadata.">
          <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} disabled={tx.busy || publishing} />
        </Field>
        <Field label="image" error={touched ? errors.image : undefined} hint="Optional https:// or ipfs:// URL.">
          <input className="field" value={image} onChange={(e) => setImage(e.target.value)} disabled={tx.busy || publishing} placeholder="https://…" />
        </Field>
      </div>
      {touched && blocking !== null && blocking !== errors.persona && <p className="text-[12px] text-danger">{blocking}</p>}
      {error !== null && <p className="text-[12px] text-danger">{error}</p>}
      <p className="text-[11px] text-mute">
        Registers the mind (dormant until step 3) and deploys its account. {walletIsRecipient ? 'You will send step 2 from this wallet too.' : 'Step 2 must then be sent by the current fee recipient.'}
      </p>
      <ChainGuard action="adopt">
        <button type="button" className="btn btn-primary w-full" disabled={tx.busy || publishing} onClick={() => void submit()}>
          {publishing ? 'Publishing metadata…' : tx.busy ? 'Registering…' : 'Register the mind'}
        </button>
      </ChainGuard>
      <TxStatus tx={tx} labels={{ confirmed: 'Registered. Next: hand over the creator fees.' }} />
    </section>
  );
}

function TransferStep({
  token,
  factory,
  account,
  recipient,
  walletIsRecipient,
  onDone,
}: {
  token: Address;
  factory: Address;
  account: Address;
  recipient: Address;
  walletIsRecipient: boolean;
  onDone: () => void;
}) {
  const write = useWriteContract();
  const tx = useTxFlow({ onConfirmed: onDone });
  return (
    <section className="panel space-y-3 p-4 text-[12px]">
      <p className="text-fg">Step 2 · hand the creator fees to the mind account</p>
      <p className="text-dim">
        On Pons, call <code>transferCreatorFeeRecipient</code> to make the mind account <AddressLink address={account} /> the recipient of this coin&apos;s
        creator fees (curve and, after graduation, the Uniswap pool). They are then harvested into the mind&apos;s vault and can only pay for its
        compute. You can take them back later with &quot;Leave&quot; on the mind page.
      </p>
      {walletIsRecipient ? (
        <ChainGuard action="transfer">
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={tx.busy}
            onClick={() =>
              void tx.run(() =>
                write.mutateAsync({ address: factory, abi: ponsFactoryAbi, functionName: 'transferCreatorFeeRecipient', args: [token, account], chainId: TARGET_CHAIN.id }),
              )
            }
          >
            {tx.busy ? 'Transferring…' : 'Transfer creator fees to the mind'}
          </button>
        </ChainGuard>
      ) : (
        <p className="rounded border border-amber/40 bg-amber/5 p-2 text-amber">
          Only the current fee recipient <AddressLink address={recipient} /> can send this. Connect that wallet, or have its owner call{' '}
          <code>transferCreatorFeeRecipient({token}, {account})</code> on the Pons factory.
        </p>
      )}
      <TxStatus tx={tx} labels={{ confirmed: 'Transferred. Last step: activate.' }} />
    </section>
  );
}

function ActivateStep({ token, onDone }: { token: Address; onDone: () => void }) {
  const write = useWriteContract();
  const tx = useTxFlow({ onConfirmed: onDone });
  return (
    <section className="panel space-y-3 p-4 text-[12px]">
      <p className="text-fg">Step 3 · activate</p>
      <p className="text-dim">The mind account now receives the creator fees. Activating wakes the mind (anyone can send this).</p>
      <ChainGuard action="activate">
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={tx.busy}
          onClick={() =>
            void tx.run(() =>
              write.mutateAsync({ address: REGISTRY_ADDRESS as Address, abi: ponsMindRegistryAbi, functionName: 'activateAdoption', args: [token], chainId: TARGET_CHAIN.id }),
            )
          }
        >
          {tx.busy ? 'Activating…' : 'Activate the mind'}
        </button>
      </ChainGuard>
      <TxStatus tx={tx} labels={{ confirmed: 'Adopted. The mind is awake.' }} />
    </section>
  );
}
