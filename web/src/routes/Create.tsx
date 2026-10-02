/**
 * `/create` — launch a coin with a mind. Pons mode (SPEC §9.5, default) renders {@link PonsCreate}
 * (Pons launch form + "Adopt an existing Pons coin"); curve mode keeps the §7 flow (directive W2):
 * metadata → `POST /api/metadata` (data: URI fallback) → `createMind(name, symbol, uri, modelId,
 * personaHash, minTokensOut)` with `value = creationFee + initialBuy` → decode `MindCreated` →
 * optional vault seed via `fundMind` → navigate to `/mind/<token>`.
 *
 * @module routes/Create
 */
import { DEFAULT_MODEL, DEFAULT_TRADE_FEE_BPS, mindLaunchpadAbi as launchpadAbi, TOTAL_SUPPLY } from '@www-rh/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { useReadContract, useWriteContract } from 'wagmi';
import { ChainGuard } from '../components/ChainGuard';
import { Field } from '../components/FormField';
import { ModelSelect } from '../components/ModelSelect';
import { MindAvatar, TxLink } from '../components/common';
import { LAUNCHPAD_ADDRESS, TARGET_CHAIN, VENUE } from '../config';
import { formatBps, formatEth, formatTokens, parseAmount } from '../format';
import { useTxFlow } from '../hooks/useTxFlow';
import { describeError } from '../lib/errors';
import { mindCreatedToken } from '../lib/events';
import { METADATA_LIMITS, PERSONA_PLACEHOLDER, buildMetadata, dataUriFits, metadataJson, modelHashOf, validateDraft, type DraftErrors, type MetadataDraft } from '../lib/metadata';
import { publishMetadata, type PublishedMetadata } from '../lib/publish';
import { DEFAULT_SLIPPAGE_BPS, planInitialBuy, slippagePercentToBps } from '../lib/quote';
import { useHealth, useModels } from '../queries';
import { PonsCreate } from './PonsCreate';

type Step = 'form' | 'publishing' | 'creating' | 'seeding' | 'done';

const EMPTY_DRAFT: MetadataDraft = {
  name: '',
  symbol: '',
  description: '',
  image: '',
  persona: '',
  model: DEFAULT_MODEL,
  links: { x: '', website: '', telegram: '' },
};

/** Create route: the Pons launch / adopt page in Pons mode, the launchpad form in curve mode. */
export function Create() {
  return VENUE === 'pons' ? <PonsCreate /> : <CurveCreate />;
}

/** Curve-mode create form (SPEC §7). */
function CurveCreate() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const models = useModels();
  const [draft, setDraft] = useState<MetadataDraft>(EMPTY_DRAFT);
  const [touched, setTouched] = useState(false);
  const [initialBuy, setInitialBuy] = useState('');
  const [seed, setSeed] = useState('');
  const [slippage, setSlippage] = useState('1');
  const [step, setStep] = useState<Step>('form');
  const [flowError, setFlowError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ json: string; result: PublishedMetadata } | null>(null);
  const [createdToken, setCreatedToken] = useState<Address | null>(null);

  const launchpad = LAUNCHPAD_ADDRESS ?? zeroAddress;
  const readBase = { address: launchpad, abi: launchpadAbi, chainId: TARGET_CHAIN.id, query: { enabled: LAUNCHPAD_ADDRESS !== null } } as const;
  const creationFee = useReadContract({ ...readBase, functionName: 'creationFee' });
  const feeParams = useReadContract({ ...readBase, functionName: 'feeParams' });
  const paused = useReadContract({ ...readBase, functionName: 'paused' });

  const errors: DraftErrors = useMemo(() => validateDraft(draft), [draft]);
  const shownErrors: DraftErrors = touched ? errors : {};
  const initialBuyWei = initialBuy.trim() === '' ? 0n : parseAmount(initialBuy);
  const seedWei = seed.trim() === '' ? 0n : parseAmount(seed);
  const slippageBps = slippagePercentToBps(slippage);
  const tradeFeeBps = feeParams.data !== undefined ? BigInt(feeParams.data.tradeFeeBps) : DEFAULT_TRADE_FEE_BPS;
  const fee = creationFee.data ?? 0n;
  const plan = useMemo(
    () =>
      initialBuyWei !== null && slippageBps !== null
        ? planInitialBuy({ initialBuyWei, creationFee: fee, tradeFeeBps, slippageBps })
        : null,
    [initialBuyWei, slippageBps, fee, tradeFeeBps],
  );
  const selectedModel = models.data?.models.find((m) => m.id === draft.model);
  const health = useHealth();
  const fallback = useMemo(() => (Object.keys(errors).length === 0 ? dataUriFits(buildMetadata(draft)) : null), [errors, draft]);

  const write = useWriteContract();
  const seedWrite = useWriteContract();

  const seedTx = useTxFlow({
    onConfirmed: () => finish(createdToken),
  });

  const createTx = useTxFlow({
    onConfirmed: (receipt: TransactionReceipt) => {
      const token = mindCreatedToken(receipt.logs, launchpad);
      if (token === null) {
        setFlowError('The transaction succeeded but no MindCreated event from this launchpad was found in the receipt.');
        setStep('form');
        return;
      }
      setCreatedToken(token);
      void queryClient.invalidateQueries({ queryKey: ['minds'] });
      if (seedWei !== null && seedWei > 0n) {
        setStep('seeding');
        void seedTx.run(() =>
          seedWrite.mutateAsync({ address: launchpad, abi: launchpadAbi, functionName: 'fundMind', args: [token], value: seedWei, chainId: TARGET_CHAIN.id }),
        );
      } else {
        finish(token);
      }
    },
  });

  function finish(token: Address | null) {
    if (token === null) return;
    setStep('done');
    void navigate(`/mind/${token}`);
  }

  // A createMind that reverts on-chain (or whose receipt cannot be fetched) returns to the form.
  useEffect(() => {
    if (step === 'creating' && (createTx.phase === 'reverted' || createTx.phase === 'error')) setStep('form');
  }, [step, createTx.phase]);

  // The vault seed is optional: a rejected or failed fundMind still lands on the new mind (SPEC §7 step 5).
  useEffect(() => {
    if (step === 'seeding' && seedTx.error !== null && createdToken !== null) {
      setStep('done');
      void navigate(`/mind/${createdToken}`, { state: { seedError: seedTx.error } });
    }
  }, [step, seedTx.error, createdToken, navigate]);

  function update<K extends keyof MetadataDraft>(key: K, value: MetadataDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const amountsValid = initialBuyWei !== null && seedWei !== null && slippageBps !== null && plan !== null;
  const canSubmit = Object.keys(errors).length === 0 && amountsValid && step === 'form' && !createTx.busy && paused.data !== true;

  async function submit() {
    setTouched(true);
    setFlowError(null);
    if (!canSubmit || initialBuyWei === null || slippageBps === null || LAUNCHPAD_ADDRESS === null) return;
    // Re-read creationFee and feeParams right before submitting (SPEC §7 step 3).
    const [freshFee, freshParams] = await Promise.all([creationFee.refetch(), feeParams.refetch()]);
    if (freshFee.data === undefined || freshParams.data === undefined) {
      setFlowError(`Could not read the creation fee from ${TARGET_CHAIN.name}: ${describeError(freshFee.error ?? freshParams.error)}`);
      return;
    }
    const finalPlan = planInitialBuy({ initialBuyWei, creationFee: freshFee.data, tradeFeeBps: BigInt(freshParams.data.tradeFeeBps), slippageBps });
    const meta = buildMetadata(draft);
    const json = metadataJson(meta);
    setStep('publishing');
    let pub: PublishedMetadata;
    try {
      // Re-use the upload when the user retries the transaction with unchanged metadata.
      pub = published !== null && published.json === json ? published.result : await publishMetadata(meta);
      setPublished({ json, result: pub });
    } catch (e) {
      setFlowError(describeError(e));
      setStep('form');
      return;
    }
    setStep('creating');
    const hash: Hex | null = await createTx.run(() =>
      write.mutateAsync({
        address: LAUNCHPAD_ADDRESS as Address,
        abi: launchpadAbi,
        functionName: 'createMind',
        args: [meta.name, meta.symbol, pub.uri, modelHashOf(meta.model), pub.personaHash, finalPlan.minTokensOut],
        value: finalPlan.value,
        chainId: TARGET_CHAIN.id,
      }),
    );
    if (hash === null) setStep('form');
  }

  const busy = step !== 'form';

  function submitLabel(): string {
    switch (step) {
      case 'publishing':
        return 'Publishing metadata…';
      case 'creating':
        return createTx.phase === 'signing' ? 'Confirm in your wallet…' : 'Creating coin…';
      case 'seeding':
        if (seedTx.error !== null) return 'Coin created';
        return seedTx.phase === 'signing' ? 'Confirm the vault seed…' : 'Seeding the vault…';
      case 'done':
        return 'Opening the mind…';
      default:
        return `Create $${draft.symbol.trim() || 'COIN'}${plan !== null && plan.value > 0n ? ` for ${formatEth(plan.value)}` : ''}`;
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="space-y-1 border-b border-line pb-4">
        <h1 className="text-xl text-fg">give a coin a mind</h1>
        <p className="text-dim">
          Name the coin, choose the model that will think for it, and write who it is. Trading fees fill its vault; the vault pays for every
          thought. Supply is fixed at 1B: 800M on the bonding curve, 200M seeded into the DEX at graduation.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <section className="panel space-y-4 p-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
              <Field label="name" error={shownErrors.name}>
                <input className={`field ${shownErrors.name ? 'field-error' : ''}`} value={draft.name} maxLength={64} disabled={busy} onChange={(e) => update('name', e.target.value)} placeholder="Night Sky Watcher" />
              </Field>
              <Field label="ticker" error={shownErrors.symbol}>
                <input className={`field uppercase ${shownErrors.symbol ? 'field-error' : ''}`} value={draft.symbol} maxLength={16} disabled={busy} onChange={(e) => update('symbol', e.target.value.toUpperCase())} placeholder="STARS" />
              </Field>
            </div>
            <Field label="description" error={shownErrors.description} hint="Optional. Shown on the coin page.">
              <textarea className="field min-h-16" value={draft.description} disabled={busy} onChange={(e) => update('description', e.target.value)} placeholder="A coin whose mind reads the sky so you don't have to." />
            </Field>
            <Field label="image" error={shownErrors.image} hint="Optional. An https:// or ipfs:// URL (up to 512 characters), square works best.">
              <div className="flex items-center gap-3">
                <MindAvatar image={draft.image.trim() === '' ? null : draft.image.trim()} symbol={draft.symbol || '?'} size={44} />
                <input
                  className={`field flex-1 ${shownErrors.image ? 'field-error' : ''}`}
                  value={draft.image}
                  maxLength={512}
                  disabled={busy}
                  onChange={(e) => update('image', e.target.value)}
                  placeholder="https://… or ipfs://…"
                />
              </div>
            </Field>
            <Field label="links" error={shownErrors.links} hint="Optional.">
              <div className="grid gap-2 sm:grid-cols-3">
                <input className="field" value={draft.links.x} disabled={busy} onChange={(e) => update('links', { ...draft.links, x: e.target.value })} placeholder="https://x.com/…" />
                <input className="field" value={draft.links.website} disabled={busy} onChange={(e) => update('links', { ...draft.links, website: e.target.value })} placeholder="https://…" />
                <input className="field" value={draft.links.telegram} disabled={busy} onChange={(e) => update('links', { ...draft.links, telegram: e.target.value })} placeholder="https://t.me/…" />
              </div>
            </Field>
          </section>

          <section className="panel space-y-4 p-4">
            <Field label="mind: model" error={shownErrors.model}>
              <ModelSelect models={models.data?.models ?? []} source={models.data?.source} value={draft.model} onChange={(id) => update('model', id)} disabled={busy} />
            </Field>
            <Field
              label="mind: persona"
              error={shownErrors.persona}
              hint={`${draft.persona.trim().length}/${METADATA_LIMITS.personaChars} characters. Stored in the metadata; its keccak256 hash goes on-chain as personaHash.`}
            >
              <textarea className={`field min-h-40 ${shownErrors.persona ? 'field-error' : ''}`} value={draft.persona} disabled={busy} onChange={(e) => update('persona', e.target.value)} placeholder={PERSONA_PLACEHOLDER} />
            </Field>
          </section>

          <section className="panel space-y-4 p-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="initial buy (ETH)" error={initialBuyWei === null ? 'Not a valid ETH amount.' : undefined} hint="Optional. You buy first, at the lowest price.">
                <input className={`field ${initialBuyWei === null ? 'field-error' : ''}`} inputMode="decimal" value={initialBuy} disabled={busy} onChange={(e) => setInitialBuy(e.target.value)} placeholder="0.0" />
              </Field>
              <Field label="slippage (%)" error={slippageBps === null ? 'Between 0.1 and 20.' : undefined} hint="Applied to the initial buy.">
                <input className={`field ${slippageBps === null ? 'field-error' : ''}`} inputMode="decimal" value={slippage} disabled={busy} onChange={(e) => setSlippage(e.target.value)} placeholder="1" />
              </Field>
              <Field label="seed the vault (ETH)" error={seedWei === null ? 'Not a valid ETH amount.' : undefined} hint="Optional. Sent with fundMind right after creation.">
                <input className={`field ${seedWei === null ? 'field-error' : ''}`} inputMode="decimal" value={seed} disabled={busy} onChange={(e) => setSeed(e.target.value)} placeholder="0.0" />
              </Field>
            </div>
            {plan !== null && plan.completes && (
              <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">
                This initial buy alone sells out the curve. You receive the remaining curve supply and {formatEth(plan.refund)} is refunded.
              </p>
            )}
          </section>

          {paused.data === true && (
            <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">The launchpad is paused by its owner: new coins cannot be created right now.</p>
          )}
          {touched && errors.schema !== undefined && <p className="text-[12px] text-danger">{errors.schema}</p>}
          {health.isError && fallback !== null && (
            <p className={`rounded border p-2 text-[12px] ${fallback.fits ? 'border-amber/40 bg-amber/5 text-amber' : 'border-danger/40 bg-danger/5 text-danger'}`}>
              The runner is not answering, so the metadata would be embedded on-chain as a data: URI ({fallback.bytes} / {METADATA_LIMITS.metadataUriBytes} bytes).
              {fallback.fits ? ' That fits.' : ' That is too large: shorten the persona or description, or try again when the runner is back.'}
            </p>
          )}
          {flowError !== null && <p className="rounded border border-danger/40 bg-danger/5 p-2 text-[12px] text-danger">{flowError}</p>}
          {createTx.error !== null && step === 'form' && <p className="text-[12px] text-danger">{createTx.error}</p>}

          <ChainGuard action="create a coin">
            <button type="submit" className="btn btn-primary w-full py-3" disabled={busy || paused.data === true || !amountsValid}>
              {submitLabel()}
            </button>
          </ChainGuard>
          {step === 'seeding' && createdToken !== null && (
            <button type="button" className="btn btn-sm w-full" onClick={() => finish(createdToken)}>
              skip seeding and open the mind
            </button>
          )}
          <StepLog step={step} published={published?.result ?? null} createHash={createTx.hash} seedHash={seedTx.hash} seedError={seedTx.error} token={createdToken} />
        </form>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <section className="panel p-4">
            <p className="label">preview</p>
            <div className="flex items-start gap-3">
              <MindAvatar image={draft.image.trim() === '' ? null : draft.image.trim()} symbol={draft.symbol || '?'} size={48} />
              <div className="min-w-0">
                <p className="truncate text-fg">
                  {draft.name.trim() || 'Unnamed'} <span className="text-dim">${draft.symbol.trim() || 'TICKER'}</span>
                </p>
                <p className="text-[12px] text-dim">{selectedModel?.label ?? draft.model}</p>
              </div>
            </div>
            <p className="mt-3 line-clamp-6 text-[12px] whitespace-pre-wrap text-dim">{draft.persona.trim() || 'The persona you write becomes the first thing the mind reads every time it wakes up.'}</p>
          </section>

          <section className="panel p-4">
            <p className="label">transaction</p>
            <dl className="text-[12px]">
              <div className="kv">
                <dt>creation fee</dt>
                <dd>{creationFee.data !== undefined ? formatEth(creationFee.data) : LAUNCHPAD_ADDRESS === null ? 'n/a' : creationFee.isError ? 'unavailable (RPC)' : '…'}</dd>
              </div>
              <div className="kv">
                <dt>initial buy</dt>
                <dd>{plan !== null ? formatEth(plan.initialBuyWei) : '—'}</dd>
              </div>
              {plan !== null && plan.initialBuyWei > 0n && (
                <>
                  <div className="kv">
                    <dt>you receive ≈</dt>
                    <dd>
                      {formatTokens(plan.tokensOut)} ${draft.symbol.trim() || 'TICKER'}
                    </dd>
                  </div>
                  <div className="kv">
                    <dt>share of supply</dt>
                    <dd>{formatBps((plan.tokensOut * 10_000n) / TOTAL_SUPPLY)}</dd>
                  </div>
                  <div className="kv">
                    <dt>min received ({slippage || '0'}%)</dt>
                    <dd>{formatTokens(plan.minTokensOut)}</dd>
                  </div>
                  <div className="kv">
                    <dt>trade fee ({formatBps(tradeFeeBps)})</dt>
                    <dd>{formatEth(plan.fee)}</dd>
                  </div>
                </>
              )}
              <div className="kv border-t border-line pt-2 text-fg">
                <dt className="text-fg">value sent</dt>
                <dd>{plan !== null ? formatEth(plan.value) : '—'}</dd>
              </div>
              {seedWei !== null && seedWei > 0n && (
                <div className="kv">
                  <dt>then: seed vault</dt>
                  <dd>{formatEth(seedWei)}</dd>
                </div>
              )}
            </dl>
            <p className="mt-2 text-[11px] text-mute">
              Quote from the shared curve math on a fresh curve (slippage {slippageBps !== null ? formatBps(slippageBps) : '—'}, default{' '}
              {formatBps(DEFAULT_SLIPPAGE_BPS)}). The trade fee is split {feeParams.data !== undefined ? formatBps(feeParams.data.mindShareBps) : '70%'} to the mind's vault and the rest to the protocol.
            </p>
          </section>
          <p className="text-[11px] text-mute">
            Prefer to look around first? <Link to="/">See the minds already running</Link>.
          </p>
        </aside>
      </div>
    </div>
  );
}

function StepLog({
  step,
  published,
  createHash,
  seedHash,
  seedError,
  token,
}: {
  step: Step;
  published: PublishedMetadata | null;
  createHash: Hex | undefined;
  seedHash: Hex | undefined;
  seedError: string | null;
  token: Address | null;
}) {
  if (step === 'form' && published === null) return null;
  return (
    <ol className="space-y-1 text-[12px] text-dim">
      {published !== null && (
        <li>
          <span className="text-acid">✓</span> metadata {published.via === 'runner' ? 'stored by the runner' : 'embedded as a data: URI (runner unreachable)'}
        </li>
      )}
      {createHash !== undefined && (
        <li>
          {token !== null ? <span className="text-acid">✓</span> : <span>…</span>} createMind <TxLink hash={createHash} />
        </li>
      )}
      {seedHash !== undefined && (
        <li>
          {step === 'done' ? <span className="text-acid">✓</span> : <span>…</span>} fundMind <TxLink hash={seedHash} />
        </li>
      )}
      {seedError !== null && token !== null && (
        <li className="text-amber">
          The coin exists but seeding the vault failed ({seedError}). <Link to={`/mind/${token}`}>Open the mind</Link> and feed it from there.
        </li>
      )}
    </ol>
  );
}
