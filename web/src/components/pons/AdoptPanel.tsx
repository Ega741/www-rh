/**
 * "Adopt an existing Pons coin" (SPEC §9.7, adoption v2): paste a Pons token → its launch record
 * (`factory.getLaunchedToken`) and the pending preparations (`GET /api/minds/:token/adoptions`,
 * each checked with `registry.pendingAdoption`) → step 1 `registry.prepareAdoption(token, modelId,
 * personaHash, metadataURI)` creates or updates the wallet's own preparation (account =
 * `predictAdoptionAccount(token, wallet)`) → step 2 the current fee recipient calls
 * `factory.transferCreatorFeeRecipient(token, account)` → step 3 anyone calls
 * `registry.activateAdoption(token, preparer)`. Activation is offered for any pending preparation
 * whose account is the recipient. A mind whose account no longer receives the fees (creator left,
 * or recipient moved) can be taken over the same way. The step is derived from chain state by
 * {@link adoptionStep}, so the flow resumes after a reload or across wallets.
 *
 * @module components/pons/AdoptPanel
 */
import { DEFAULT_MODEL } from '@www-rh/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { erc20Abi, isAddress, zeroAddress, type Address } from 'viem';
import { useConnection, useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../../config';
import { formatBps, formatEth } from '../../format';
import { usePonsFactory } from '../../hooks/usePons';
import { useTxFlow } from '../../hooks/useTxFlow';
import { describeError } from '../../lib/errors';
import { METADATA_LIMITS, PERSONA_PLACEHOLDER, buildMetadata, modelHashOf, validateDraft, type MetadataDraft } from '../../lib/metadata';
import {
  adoptionStep,
  adoptionStepNumber,
  factoryPhaseName,
  mergePendingPreparations,
  mindAdoptedFromLogs,
  pendingFromChain,
  ponsFactoryAbi,
  ponsMindRegistryAbi,
  sameAddress,
  type AdoptionStep,
  type MindAdoptedEvent,
  type MindState,
  type PendingPreparation,
  type TakeoverReason,
} from '../../lib/pons';
import { publishMetadata } from '../../lib/publish';
import { useMindAdoptions, useMindDetail, useModels, useSettledError } from '../../queries';
import { ChainGuard } from '../ChainGuard';
import { Field } from '../FormField';
import { ModelSelect } from '../ModelSelect';
import { AddressLink, CopyButton, TxStatus } from '../common';

/** Most runner-listed preparations checked on chain. */
const MAX_PENDING = 25;

const STEPS = [
  { n: 1, title: 'Prepare your adoption', who: 'you (anyone can prepare)', fn: 'registry.prepareAdoption' },
  { n: 2, title: 'Hand the creator fees to your account', who: 'the current fee recipient', fn: 'factory.transferCreatorFeeRecipient' },
  { n: 3, title: 'Activate', who: 'anyone', fn: 'registry.activateAdoption(token, preparer)' },
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
          Give a Pons coin a mind without relaunching it: prepare an adoption (your model, persona and your own mind account), have the coin&apos;s
          creator-fee recipient point its Pons creator fees at that account, then activate. From then on the fees pay for the mind&apos;s thinking. A
          mind whose account no longer receives the fees (its creator left) can be taken over the same way.
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
  const wallet = address !== undefined ? (address.toLowerCase() as Address) : undefined;
  const factory = usePonsFactory();
  const queryClient = useQueryClient();
  const regEnabled = REGISTRY_ADDRESS !== null;
  const reg = { address: REGISTRY_ADDRESS ?? zeroAddress, abi: ponsMindRegistryAbi, chainId: TARGET_CHAIN.id } as const;
  const launch = useReadContract({
    address: factory ?? zeroAddress,
    abi: ponsFactoryAbi,
    functionName: 'getLaunchedToken',
    args: [token],
    chainId: TARGET_CHAIN.id,
    query: { enabled: factory !== null, refetchInterval: 10_000 },
  });
  const isMind = useReadContract({ ...reg, functionName: 'isMind', args: [token], query: { enabled: regEnabled, refetchInterval: 10_000 } });
  const record = useReadContract({ ...reg, functionName: 'ponsMind', args: [token], query: { enabled: regEnabled, refetchInterval: 10_000 } });
  const leftRead = useReadContract({ ...reg, functionName: 'hasLeft', args: [token], query: { enabled: regEnabled && isMind.data === true, refetchInterval: 30_000, retry: false } });
  // the runner's MindDetail.pons.left, only when the registry cannot answer hasLeft
  const detail = useMindDetail(isMind.data === true && leftRead.isError ? token : undefined);
  const mine = useReadContract({
    ...reg,
    functionName: 'pendingAdoption',
    args: [token, wallet ?? zeroAddress],
    query: { enabled: regEnabled && wallet !== undefined, refetchInterval: 10_000 },
  });
  const predicted = useReadContract({
    ...reg,
    functionName: 'predictAdoptionAccount',
    args: [token, wallet ?? zeroAddress],
    query: { enabled: regEnabled && wallet !== undefined, staleTime: Infinity },
  });
  const adoptions = useMindAdoptions(token);
  const adoptionsError = useSettledError(adoptions);
  const apiList = (adoptions.data ?? []).slice(0, MAX_PENDING);
  const verify = useReadContracts({
    contracts: apiList.map((p) => ({ ...reg, functionName: 'pendingAdoption' as const, args: [token, p.preparer] as const })),
    query: { enabled: regEnabled && apiList.length > 0, refetchInterval: 15_000 },
  });
  const name = useReadContract({ address: token, abi: erc20Abi, functionName: 'name', chainId: TARGET_CHAIN.id, query: { staleTime: Infinity, retry: false } });
  const symbol = useReadContract({ address: token, abi: erc20Abi, functionName: 'symbol', chainId: TARGET_CHAIN.id, query: { staleTime: Infinity, retry: false } });

  const mineRecord = wallet !== undefined && mine.data !== undefined ? pendingFromChain(wallet, mine.data) : undefined;
  const checked = apiList.map((p, i) => {
    const r = verify.data?.[i];
    return r !== undefined && r.status === 'success' ? pendingFromChain(p.preparer, r.result) : undefined;
  });
  const pending = mergePendingPreparations(apiList, checked, mineRecord ?? null);
  const mindState: MindState | null | undefined =
    isMind.isError || record.isError
      ? null
      : isMind.data === undefined || record.data === undefined
        ? undefined
        : { isMind: isMind.data, account: record.data.account, launchedHere: record.data.launchedHere, left: leftRead.data ?? detail.data?.pons?.left ?? null };

  const step: AdoptionStep = adoptionStep({
    wallet,
    launch: launch.isError ? null : launch.data,
    mind: mindState,
    mine: wallet === undefined ? undefined : mine.isError ? null : mineRecord,
    pending,
    predictedAccount: predicted.data,
  });
  const current = adoptionStepNumber(step);
  const [editing, setEditing] = useState(false);
  const [activated, setActivated] = useState<MindAdoptedEvent | null>(null);
  const refresh = () => {
    setEditing(false);
    void launch.refetch();
    void isMind.refetch();
    void record.refetch();
    void leftRead.refetch();
    void mine.refetch();
    void verify.refetch();
    void adoptions.refetch();
    void queryClient.invalidateQueries({ queryKey: ['minds'] });
  };

  if (REGISTRY_ADDRESS === null || factory === null) {
    return <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">No PonsMindRegistry / Pons factory is configured for {TARGET_CHAIN.name}.</p>;
  }

  const recipient = launch.data !== undefined && launch.data.exists ? launch.data.creatorFeeRecipient : null;
  const takeover = 'takeover' in step ? step.takeover : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        {step.kind === 'loading' && <div className="panel h-40 animate-pulse" aria-busy="true" />}
        {step.kind === 'error' && (
          <p className="rounded border border-danger/40 bg-danger/5 p-2 text-[12px] text-danger">
            Could not read this token from {TARGET_CHAIN.name}: {describeError(launch.error ?? isMind.error ?? record.error ?? mine.error)}
          </p>
        )}
        {step.kind === 'not-pons' && (
          <p className="rounded border border-amber/40 bg-amber/5 p-3 text-[12px] text-amber">
            The Pons V2 factory has no launch for this address. Only coins launched on Pons V2 can be adopted.
          </p>
        )}
        {step.kind === 'unsupported-quote' && (
          <p className="rounded border border-amber/40 bg-amber/5 p-3 text-[12px] text-amber">
            This Pons launch trades against an ERC-20 (<AddressLink address={step.pairToken} />), not native ETH. Minds can only be attached to native-ETH
            launches.
          </p>
        )}
        {step.kind === 'buyback-enabled' && (
          <p className="rounded border border-amber/40 bg-amber/5 p-3 text-[12px] text-amber">
            This Pons launch has buyback enabled: part of its fees is spent on buybacks instead of reaching the creator. The registry only adopts launches
            without buyback, so this coin cannot get a mind here.
          </p>
        )}
        {step.kind === 'active' && (
          <section className="panel space-y-2 p-4">
            {activated !== null && (
              <p className="text-acid">
                {activated.created ? 'Adopted: the mind is registered and awake.' : 'Taken over: the mind is yours now and awake.'} Creator{' '}
                <AddressLink address={activated.creator} />, account <AddressLink address={activated.account} />.
              </p>
            )}
            <p className="text-fg">{step.launchedHere ? 'This coin was launched with a mind here.' : 'This coin has a mind.'}</p>
            <p className="text-[12px] text-dim">
              Its account <AddressLink address={step.account} /> receives the coin&apos;s creator fees, so it cannot be adopted or taken over. That only
              becomes possible once its account stops receiving the fees (for example after its creator leaves).
            </p>
            {step.left && (
              <p className="text-[12px] text-amber">Its creator left, and the fees were later handed back to the mind account; the mind stays dormant.</p>
            )}
            <Link to={`/mind/${token}`} className="btn btn-primary btn-sm hover:no-underline">
              open the mind
            </Link>
          </section>
        )}
        {takeover !== null && <TakeoverNotice token={token} reason={takeover} />}
        {step.kind === 'connect' && (
          <section className="panel space-y-2 p-4 text-[12px]">
            <p className="text-dim">
              Connect a wallet to prepare an adoption. Anyone can prepare one; the coin&apos;s current creator-fee recipient
              {recipient !== null && (
                <>
                  {' '}
                  (<AddressLink address={recipient} />)
                </>
              )}{' '}
              then has to hand the fees to your mind account.
            </p>
            <ChainGuard action="adopt">
              <span />
            </ChainGuard>
          </section>
        )}
        {step.kind === 'prepare' && (
          <PrepareStep
            token={token}
            name={name.data ?? null}
            symbol={symbol.data ?? null}
            predictedAccount={step.predictedAccount}
            recipient={step.recipient}
            walletIsRecipient={step.walletIsRecipient}
            existing={null}
            onDone={refresh}
          />
        )}
        {step.kind === 'transfer' &&
          (editing && mineRecord !== undefined ? (
            <PrepareStep
              token={token}
              name={name.data ?? null}
              symbol={symbol.data ?? null}
              predictedAccount={step.account}
              recipient={step.recipient}
              walletIsRecipient={step.walletIsRecipient}
              existing={mineRecord}
              onDone={refresh}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <TransferStep
              token={token}
              factory={factory}
              wallet={wallet}
              account={step.account}
              recipient={step.recipient}
              walletIsRecipient={step.walletIsRecipient}
              onEdit={() => setEditing(true)}
              onDone={refresh}
            />
          ))}
        {step.kind === 'activate' && (
          <ActivateStep
            token={token}
            preparer={step.preparer}
            account={step.account}
            mine={step.mine}
            takeover={step.takeover}
            onDone={(result) => {
              setActivated(result);
              refresh();
            }}
          />
        )}
        {launch.data !== undefined && launch.data.exists && (
          <PendingList pending={pending} recipient={recipient} wallet={wallet} loading={adoptions.isPending && adoptionsError === null} error={adoptionsError} />
        )}
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
                  {sameAddress(wallet, launch.data.creatorFeeRecipient) && <span className="text-acid"> (you)</span>}
                </dd>
              </div>
              <div className="kv">
                <dt>creator tax</dt>
                <dd>{formatBps(launch.data.creatorTaxBps)}</dd>
              </div>
              <div className="kv">
                <dt>quote · buyback</dt>
                <dd>
                  {launch.data.pairToken === zeroAddress ? 'ETH' : 'ERC-20'} · {launch.data.buybackEnabled ? <span className="text-amber">on</span> : 'off'}
                </dd>
              </div>
              <div className="kv">
                <dt>graduates at</dt>
                <dd>{formatEth(launch.data.graduationThreshold, { maxFraction: 3 })}</dd>
              </div>
              <div className="kv">
                <dt>phase</dt>
                <dd>{factoryPhaseName(launch.data.phase)}</dd>
              </div>
              <div className="kv">
                <dt>mind here</dt>
                <dd>
                  {mindState === undefined || mindState === null ? (
                    '…'
                  ) : !mindState.isMind ? (
                    'none yet'
                  ) : (
                    <Link to={`/mind/${token}`}>{mindState.left === true ? 'yes (creator left)' : sameAddress(mindState.account, recipient) ? 'yes' : 'yes (not receiving fees)'}</Link>
                  )}
                </dd>
              </div>
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

function TakeoverNotice({ token, reason }: { token: Address; reason: TakeoverReason }) {
  return (
    <p className="rounded border border-info/40 bg-info/5 p-3 text-[12px] text-info">
      This coin already has a <Link to={`/mind/${token}`}>mind here</Link>, but its account no longer receives the coin&apos;s creator fees (
      {reason === 'left' ? 'its creator left' : 'the fee recipient was moved away from it'}). Activating an adoption <strong>takes the mind over</strong>: the
      preparer becomes its creator, their model, persona and account replace the current ones, and the vault balance stays with the mind for compute.
    </p>
  );
}

function RecipientWarning({ wallet, recipient, action }: { wallet: Address | undefined; recipient: Address; action: string }) {
  return (
    <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">
      {wallet !== undefined ? (
        <>
          Your wallet <AddressLink address={wallet} /> is <strong>not</strong> this coin&apos;s current creator-fee recipient (
          <AddressLink address={recipient} />
          ).
        </>
      ) : (
        <>
          The current creator-fee recipient is <AddressLink address={recipient} />.
        </>
      )}{' '}
      {action}
    </p>
  );
}

function PrepareStep({
  token,
  name,
  symbol,
  predictedAccount,
  recipient,
  walletIsRecipient,
  existing,
  onDone,
  onCancel,
}: {
  token: Address;
  name: string | null;
  symbol: string | null;
  predictedAccount: Address | null;
  recipient: Address;
  walletIsRecipient: boolean;
  /** The wallet's pending preparation when updating it. */
  existing: PendingPreparation | null;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { address } = useConnection();
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
  const busy = tx.busy || publishing;

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
      <p className="text-fg">{existing !== null ? 'Update your preparation' : 'Step 1 · prepare your adoption'}</p>
      <div className="rounded border border-line p-2 text-[12px] text-dim">
        your mind account{' '}
        {predictedAccount !== null ? (
          <>
            <AddressLink address={predictedAccount} /> <CopyButton value={predictedAccount} />
          </>
        ) : (
          <span className="text-mute">(computing…)</span>
        )}
        <span className="block text-[11px] text-mute">
          {existing !== null
            ? 'Already deployed; updating replaces the pending model, persona and metadata and keeps this account.'
            : 'predictAdoptionAccount(token, your wallet): deployed by this transaction, one per coin and preparer. Step 2 hands the coin’s creator fees to it.'}
        </span>
      </div>
      {!walletIsRecipient && (
        <RecipientWarning
          wallet={address !== undefined ? (address.toLowerCase() as Address) : undefined}
          recipient={recipient}
          action="You can still prepare, but step 2 (handing the fees to your account) can only be sent by the recipient."
        />
      )}
      <Field label="mind: model">
        <ModelSelect models={models.data?.models ?? []} source={models.data?.source} value={model} onChange={setModel} disabled={busy} />
      </Field>
      <Field label="mind: persona" error={touched ? errors.persona : undefined} hint={`${persona.trim().length}/${METADATA_LIMITS.personaChars} characters; its keccak256 goes on-chain as personaHash.`}>
        <textarea className="field min-h-40" value={persona} onChange={(e) => setPersona(e.target.value)} disabled={busy} placeholder={PERSONA_PLACEHOLDER} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="description" error={touched ? errors.description : undefined} hint="Optional, for the metadata.">
          <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
        </Field>
        <Field label="image" error={touched ? errors.image : undefined} hint="Optional https:// or ipfs:// URL.">
          <input className="field" value={image} onChange={(e) => setImage(e.target.value)} disabled={busy} placeholder="https://…" />
        </Field>
      </div>
      {touched && blocking !== null && blocking !== errors.persona && <p className="text-[12px] text-danger">{blocking}</p>}
      {error !== null && <p className="text-[12px] text-danger">{error}</p>}
      <p className="text-[11px] text-mute">
        Nothing is registered yet: the mind is created (or taken over) only at step 3, with the config of the preparation whose account receives the
        fees. Other people may prepare their own adoption of the same coin; the recipient decides whose account gets the fees.
      </p>
      <div className="flex gap-2">
        {onCancel !== undefined && (
          <button type="button" className="btn flex-1" onClick={onCancel} disabled={busy}>
            cancel
          </button>
        )}
        <div className="flex-[2]">
          <ChainGuard action="adopt">
            <button type="button" className="btn btn-primary w-full" disabled={busy} onClick={() => void submit()}>
              {publishing ? 'Publishing metadata…' : tx.busy ? 'Preparing…' : existing !== null ? 'Update preparation' : 'Prepare adoption'}
            </button>
          </ChainGuard>
        </div>
      </div>
      <TxStatus tx={tx} labels={{ confirmed: existing !== null ? 'Preparation updated.' : 'Prepared. Next: hand the creator fees to your account.' }} />
    </section>
  );
}

function TransferStep({
  token,
  factory,
  wallet,
  account,
  recipient,
  walletIsRecipient,
  onEdit,
  onDone,
}: {
  token: Address;
  factory: Address;
  wallet: Address | undefined;
  account: Address;
  recipient: Address;
  walletIsRecipient: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const write = useWriteContract();
  const tx = useTxFlow({ onConfirmed: onDone });
  return (
    <section className="panel space-y-3 p-4 text-[12px]">
      <p className="text-fg">Step 2 · hand the creator fees to your mind account</p>
      <dl>
        <div className="kv">
          <dt>preparer</dt>
          <dd>{wallet !== undefined ? <AddressLink address={wallet} /> : '—'} (you)</dd>
        </div>
        <div className="kv">
          <dt>your mind account</dt>
          <dd>
            <AddressLink address={account} /> <CopyButton value={account} />
          </dd>
        </div>
        <div className="kv">
          <dt>current recipient</dt>
          <dd>
            <AddressLink address={recipient} />
          </dd>
        </div>
      </dl>
      <p className="text-dim">
        On Pons, <code>transferCreatorFeeRecipient(token, account)</code> makes your mind account the recipient of this coin&apos;s creator fees (curve
        and, after graduation, the Uniswap pool). They are then harvested into the mind&apos;s vault and can only pay for its compute. The creator can take
        them back later with &quot;Leave&quot; on the mind page.
      </p>
      {!walletIsRecipient && (
        <RecipientWarning
          wallet={wallet}
          recipient={recipient}
          action={`Only the recipient can send this transfer, so the button is disabled. Connect that wallet, or have its owner call transferCreatorFeeRecipient(${token}, ${account}) on the Pons factory ${factory}.`}
        />
      )}
      <ChainGuard action="transfer">
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={tx.busy || !walletIsRecipient}
          onClick={() =>
            void tx.run(() =>
              write.mutateAsync({ address: factory, abi: ponsFactoryAbi, functionName: 'transferCreatorFeeRecipient', args: [token, account], chainId: TARGET_CHAIN.id }),
            )
          }
        >
          {tx.busy ? 'Transferring…' : walletIsRecipient ? 'Transfer creator fees to my mind account' : 'Only the current recipient can transfer'}
        </button>
      </ChainGuard>
      <TxStatus tx={tx} labels={{ confirmed: 'Transferred. Last step: activate.' }} />
      <button type="button" className="text-[11px] text-mute underline" onClick={onEdit} disabled={tx.busy}>
        change the model or persona of my preparation
      </button>
    </section>
  );
}

function ActivateStep({
  token,
  preparer,
  account,
  mine,
  takeover,
  onDone,
}: {
  token: Address;
  preparer: Address;
  account: Address;
  mine: boolean;
  takeover: TakeoverReason | null;
  /** Called with the decoded `MindAdopted` (or `null` when the receipt has none from the registry). */
  onDone: (result: MindAdoptedEvent | null) => void;
}) {
  const write = useWriteContract();
  const tx = useTxFlow({
    onConfirmed: (receipt) => onDone(REGISTRY_ADDRESS !== null ? mindAdoptedFromLogs(receipt.logs, REGISTRY_ADDRESS) : null),
  });
  return (
    <section className="panel space-y-3 p-4 text-[12px]">
      <p className="text-fg">Step 3 · activate</p>
      <p className="text-dim">
        The account <AddressLink address={account} />, prepared by {mine ? 'you' : <AddressLink address={preparer} />}, now receives the creator fees.
        Activating {takeover !== null ? 'takes the existing mind over with this preparation' : 'registers the mind with this preparation'} and wakes it.
        Anyone can send this.
      </p>
      <ChainGuard action="activate">
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={tx.busy}
          onClick={() =>
            void tx.run(() =>
              write.mutateAsync({
                address: REGISTRY_ADDRESS as Address,
                abi: ponsMindRegistryAbi,
                functionName: 'activateAdoption',
                args: [token, preparer],
                chainId: TARGET_CHAIN.id,
              }),
            )
          }
        >
          {tx.busy ? 'Activating…' : takeover !== null ? 'Activate (take over the mind)' : 'Activate the mind'}
        </button>
      </ChainGuard>
      <TxStatus tx={tx} labels={{ confirmed: 'Activated.' }} />
    </section>
  );
}

function PendingList({
  pending,
  recipient,
  wallet,
  loading,
  error,
}: {
  pending: readonly PendingPreparation[];
  recipient: Address | null;
  wallet: Address | undefined;
  loading: boolean;
  error: unknown;
}) {
  return (
    <section className="panel space-y-2 p-4 text-[12px]">
      <p className="label">pending preparations{pending.length > 0 ? ` (${pending.length})` : ''}</p>
      {pending.length === 0 ? (
        <p className="text-mute">{loading ? 'loading…' : 'None yet.'}</p>
      ) : (
        <ul className="divide-y divide-line">
          {pending.map((p) => {
            const ready = sameAddress(p.account, recipient);
            return (
              <li key={p.preparer} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  preparer <AddressLink address={p.preparer} />
                  {sameAddress(p.preparer, wallet) && <span className="text-acid"> (you)</span>}
                </span>
                <span>
                  account <AddressLink address={p.account} />
                </span>
                <span className={ready ? 'text-acid' : 'text-mute'}>{ready ? 'receives the fees: ready to activate' : 'waiting for the hand-off'}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-mute">
        From the runner, each checked on chain with pendingAdoption(token, preparer). Only the preparation whose account the recipient hands the fees to
        can be activated.
        {error !== null && error !== undefined && <span className="text-amber"> The runner list is unavailable ({describeError(error)}); only your own preparation is shown.</span>}
      </p>
    </section>
  );
}
