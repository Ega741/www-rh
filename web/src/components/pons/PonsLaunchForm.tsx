/**
 * Pons launch form (SPEC §9.5): name, symbol, logo URL, description, socials, creator tax slider
 * (0..`maxCreatorTaxBps` from `/api/launch-config`), launch config, initial buy with a
 * `ponsQuoteBuy` preview on the config's fresh curve, model and persona. Flow: metadata
 * (`POST /api/metadata`, data: URI fallback) → fresh reads (`creationFee`, `launchFee`,
 * `getLaunchConfig`, `previewLaunchEconomics(configId, 0x0)`) → `registry.launchMind{value:
 * launchFee + quoteIn + creationFee}` with `salt = keccak256(utf8(name + ' ' + symbol + ' ' +
 * nonce))` → decode `MindLaunched` → `/mind/<token>`.
 *
 * @module components/pons/PonsLaunchForm
 */
import { DEFAULT_MODEL } from '@www-rh/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../../config';
import { formatBps, formatEth, formatTokens, parseAmount } from '../../format';
import { usePonsFactory, usePonsLaunchSettings } from '../../hooks/usePons';
import { useTxFlow } from '../../hooks/useTxFlow';
import { describeError } from '../../lib/errors';
import { METADATA_LIMITS, PERSONA_PLACEHOLDER, buildMetadata, dataUriFits, metadataJson, modelHashOf, validateDraft, type DraftErrors, type MetadataDraft } from '../../lib/metadata';
import {
  DEFAULT_MAX_CREATOR_TAX_BPS,
  buildLaunchParams,
  clampCreatorTaxBps,
  creatorTaxError,
  defaultLaunchConfig,
  freshLaunchNonce,
  launchSalt,
  launchedTokenFromLogs,
  planPonsLaunch,
  ponsFactoryAbi,
  ponsMindRegistryAbi,
  socialsError,
  tryPlanPonsLaunch,
  type PonsLaunchConfig,
} from '../../lib/pons';
import { publishMetadata, type PublishedMetadata } from '../../lib/publish';
import { DEFAULT_SLIPPAGE_BPS, slippagePercentToBps } from '../../lib/quote';
import { useHealth, useModels } from '../../queries';
import { ChainGuard } from '../ChainGuard';
import { Field } from '../FormField';
import { ModelSelect } from '../ModelSelect';
import { MindAvatar, TxLink } from '../common';

type Step = 'form' | 'publishing' | 'reading' | 'launching' | 'done';

const EMPTY_DRAFT: MetadataDraft = {
  name: '',
  symbol: '',
  description: '',
  image: '',
  persona: '',
  model: DEFAULT_MODEL,
  links: { x: '', website: '', telegram: '' },
};

/** Default creator tax: 1 % (it is paid to the mind account and funds compute). */
const DEFAULT_CREATOR_TAX_BPS = 100;

function configLabel(c: PonsLaunchConfig): string {
  return `#${c.id.toString()} · supply ${formatTokens(c.supply)} · graduates at ${formatEth(c.graduationThreshold, { maxFraction: 3 })} · fee ${formatBps(c.curveFeeBps)}${c.enabled ? '' : ' · disabled'}`;
}

/** See module docs. */
export function PonsLaunchForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const models = useModels();
  const health = useHealth();
  const client = usePublicClient({ chainId: TARGET_CHAIN.id });
  const factory = usePonsFactory();
  const launch = usePonsLaunchSettings();
  const settings = launch.settings;
  const [draft, setDraft] = useState<MetadataDraft>(EMPTY_DRAFT);
  const [extra, setExtra] = useState({ discord: '', farcaster: '' });
  const [touched, setTouched] = useState(false);
  const [taxBps, setTaxBps] = useState(DEFAULT_CREATOR_TAX_BPS);
  const [configId, setConfigId] = useState<bigint | null>(null);
  const [initialBuy, setInitialBuy] = useState('');
  const [slippage, setSlippage] = useState('1');
  const [step, setStep] = useState<Step>('form');
  const [flowError, setFlowError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ json: string; result: PublishedMetadata } | null>(null);
  const [launchedToken, setLaunchedToken] = useState<Address | null>(null);

  const reg = { address: REGISTRY_ADDRESS ?? zeroAddress, abi: ponsMindRegistryAbi, chainId: TARGET_CHAIN.id, query: { enabled: REGISTRY_ADDRESS !== null } } as const;
  const creationFee = useReadContract({ ...reg, functionName: 'creationFee' });
  const paused = useReadContract({ ...reg, functionName: 'paused' });
  const canLaunch = useReadContract({
    address: factory ?? zeroAddress,
    abi: ponsFactoryAbi,
    functionName: 'canLaunch',
    args: [REGISTRY_ADDRESS ?? zeroAddress],
    chainId: TARGET_CHAIN.id,
    query: { enabled: factory !== null && REGISTRY_ADDRESS !== null, staleTime: 60_000 },
  });

  const maxTax = settings?.maxCreatorTaxBps ?? DEFAULT_MAX_CREATOR_TAX_BPS;
  const configs = useMemo(() => settings?.configs ?? [], [settings]);
  const config = configs.find((c) => c.id === configId) ?? defaultLaunchConfig(configs);
  useEffect(() => {
    if (configId === null && config !== null) setConfigId(config.id);
  }, [configId, config]);
  useEffect(() => {
    if (settings !== undefined) setTaxBps((t) => clampCreatorTaxBps(t, settings.maxCreatorTaxBps));
  }, [settings]);

  const socials = { twitter: draft.links.x, telegram: draft.links.telegram, discord: extra.discord, website: draft.links.website, farcaster: extra.farcaster };
  const errors: DraftErrors = useMemo(() => validateDraft(draft), [draft]);
  const socialError = socialsError(socials);
  const taxError = creatorTaxError(taxBps, maxTax, config);
  const configError = config === null ? (launch.loading ? 'Loading launch configurations…' : 'No enabled Pons launch configuration is available.') : !config.enabled ? 'This launch configuration is disabled by Pons.' : null;
  const shownErrors: DraftErrors = touched ? errors : {};
  const quoteIn = initialBuy.trim() === '' ? 0n : parseAmount(initialBuy);
  const slippageBps = slippagePercentToBps(slippage);
  const fee = creationFee.data ?? 0n;
  const plan = useMemo(
    () =>
      config !== null && settings !== undefined && quoteIn !== null && slippageBps !== null
        ? tryPlanPonsLaunch({ config, launchFee: settings.launchFee, creationFee: fee, quoteIn, creatorTaxBps: taxBps, slippageBps })
        : null,
    [config, settings, quoteIn, slippageBps, fee, taxBps],
  );
  const selectedModel = models.data?.models.find((m) => m.id === draft.model);
  const fallback = useMemo(() => (Object.keys(errors).length === 0 ? dataUriFits(buildMetadata(draft)) : null), [errors, draft]);

  const write = useWriteContract();
  const launchTx = useTxFlow({
    onConfirmed: (receipt: TransactionReceipt) => {
      const token = REGISTRY_ADDRESS !== null ? launchedTokenFromLogs(receipt.logs, REGISTRY_ADDRESS) : null;
      if (token === null) {
        setFlowError('The transaction succeeded but no MindLaunched event from this registry was found in the receipt.');
        setStep('form');
        return;
      }
      setLaunchedToken(token);
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['minds'] });
      void navigate(`/mind/${token}`);
    },
  });

  useEffect(() => {
    if (step === 'launching' && (launchTx.phase === 'reverted' || launchTx.phase === 'error')) setStep('form');
  }, [step, launchTx.phase]);

  function update<K extends keyof MetadataDraft>(key: K, value: MetadataDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const amountsValid = quoteIn !== null && slippageBps !== null && plan !== null;
  const formValid = Object.keys(errors).length === 0 && socialError === null && taxError === null && configError === null;
  const blocked = paused.data === true || canLaunch.data === false || REGISTRY_ADDRESS === null;
  const busy = step !== 'form';

  async function submit() {
    setTouched(true);
    setFlowError(null);
    if (!formValid || !amountsValid || blocked || busy || config === null || quoteIn === null || slippageBps === null) return;
    if (client === undefined || factory === null || REGISTRY_ADDRESS === null) {
      setFlowError(`Cannot reach ${TARGET_CHAIN.name} (or the Pons factory is unknown).`);
      return;
    }
    const meta = buildMetadata(draft);
    const json = metadataJson(meta);
    setStep('publishing');
    let pub: PublishedMetadata;
    try {
      pub = published !== null && published.json === json ? published.result : await publishMetadata(meta);
      setPublished({ json, result: pub });
    } catch (e) {
      setFlowError(describeError(e));
      setStep('form');
      return;
    }
    // Fresh terms right before sending (SPEC §9.5): the economics pin makes a re-peg revert instead of repricing.
    setStep('reading');
    let finalPlan: ReturnType<typeof planPonsLaunch>;
    let economics: Hex;
    try {
      const [freshCreationFee, launchFee, freshConfig, preview] = await Promise.all([
        client.readContract({ address: REGISTRY_ADDRESS, abi: ponsMindRegistryAbi, functionName: 'creationFee' }),
        client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: 'launchFee' }),
        client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: 'getLaunchConfig', args: [config.id] }),
        client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: 'previewLaunchEconomics', args: [config.id, zeroAddress] }),
      ]);
      if (!freshConfig.enabled) throw new Error('This launch configuration was just disabled by Pons. Pick another one.');
      economics = preview;
      finalPlan = planPonsLaunch({
        config: { supply: freshConfig.supply, curveFeeBps: Number(freshConfig.curveFeeBps), phantomQuote: freshConfig.phantomQuote, graduationThreshold: freshConfig.graduationThreshold },
        launchFee,
        creationFee: freshCreationFee,
        quoteIn,
        creatorTaxBps: taxBps,
        slippageBps,
      });
    } catch (e) {
      setFlowError(`Could not read the launch terms from ${TARGET_CHAIN.name}: ${describeError(e)}`);
      setStep('form');
      return;
    }
    const params = buildLaunchParams({
      name: meta.name,
      symbol: meta.symbol,
      logo: draft.image,
      description: draft.description,
      socials,
      creatorTaxBps: taxBps,
      expectedEconomics: economics,
      salt: launchSalt(meta.name, meta.symbol, freshLaunchNonce()),
      launchConfigId: config.id,
    });
    setStep('launching');
    const hash = await launchTx.run(() =>
      write.mutateAsync({
        address: REGISTRY_ADDRESS as Address,
        abi: ponsMindRegistryAbi,
        functionName: 'launchMind',
        args: [params, finalPlan.quoteIn, finalPlan.minTokensOut, modelHashOf(meta.model), pub.personaHash, pub.uri],
        value: finalPlan.value,
        chainId: TARGET_CHAIN.id,
      }),
    );
    if (hash === null) setStep('form');
  }

  function submitLabel(): string {
    switch (step) {
      case 'publishing':
        return 'Publishing metadata…';
      case 'reading':
        return 'Reading the launch terms…';
      case 'launching':
        return launchTx.phase === 'signing' ? 'Confirm in your wallet…' : 'Launching on Pons…';
      case 'done':
        return 'Opening the mind…';
      default:
        return `Launch $${draft.symbol.trim() || 'COIN'} on Pons${plan !== null ? ` for ${formatEth(plan.value)}` : ''}`;
    }
  }

  const ticker = draft.symbol.trim() || 'TICKER';

  return (
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
          <Field label="description" error={shownErrors.description} hint="Optional. Stored on the Pons token and in the mind's metadata.">
            <textarea className="field min-h-16" value={draft.description} disabled={busy} onChange={(e) => update('description', e.target.value)} placeholder="A coin whose mind reads the sky so you don't have to." />
          </Field>
          <Field label="logo" error={shownErrors.image} hint="Optional. An https:// or ipfs:// image URL (up to 512 characters), square works best.">
            <div className="flex items-center gap-3">
              <MindAvatar image={draft.image.trim() === '' ? null : draft.image.trim()} symbol={draft.symbol || '?'} size={44} />
              <input className={`field flex-1 ${shownErrors.image ? 'field-error' : ''}`} value={draft.image} maxLength={512} disabled={busy} onChange={(e) => update('image', e.target.value)} placeholder="https://… or ipfs://…" />
            </div>
          </Field>
          <Field label="socials" error={touched ? (shownErrors.links ?? socialError ?? undefined) : undefined} hint="Optional full https:// URLs. All five go on the Pons token; x, website and telegram also go into the metadata.">
            <div className="grid gap-2 sm:grid-cols-3">
              <input className="field" value={draft.links.x} disabled={busy} onChange={(e) => update('links', { ...draft.links, x: e.target.value })} placeholder="https://x.com/…" aria-label="x / twitter" />
              <input className="field" value={draft.links.telegram} disabled={busy} onChange={(e) => update('links', { ...draft.links, telegram: e.target.value })} placeholder="https://t.me/…" aria-label="telegram" />
              <input className="field" value={draft.links.website} disabled={busy} onChange={(e) => update('links', { ...draft.links, website: e.target.value })} placeholder="https://… (website)" aria-label="website" />
              <input className="field" value={extra.discord} disabled={busy} onChange={(e) => setExtra((x) => ({ ...x, discord: e.target.value }))} placeholder="https://discord.gg/…" aria-label="discord" />
              <input className="field" value={extra.farcaster} disabled={busy} onChange={(e) => setExtra((x) => ({ ...x, farcaster: e.target.value }))} placeholder="https://warpcast.com/…" aria-label="farcaster" />
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
          <Field label="launch config" error={touched || config !== null ? (configError ?? undefined) : undefined} hint={launch.source === 'chain' ? 'Read from the Pons factory (the runner is unreachable).' : undefined}>
            <select className="field" value={config?.id.toString() ?? ''} disabled={busy || configs.length === 0} onChange={(e) => setConfigId(BigInt(e.target.value))}>
              {configs.length === 0 && <option value="">{launch.loading ? 'loading…' : 'no configurations'}</option>}
              {configs.map((c) => (
                <option key={c.id.toString()} value={c.id.toString()} disabled={!c.enabled}>
                  {configLabel(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={`creator tax: ${formatBps(taxBps)}`}
            error={taxError ?? undefined}
            hint={`0 to ${formatBps(maxTax)} on every curve trade, on top of the ${config !== null ? formatBps(config.curveFeeBps) : 'Pons'} fee. Paid in full to the mind's account and harvested into its vault for compute.`}
          >
            <input
              type="range"
              className="w-full accent-acid"
              min={0}
              max={maxTax}
              step={10}
              value={Math.min(taxBps, maxTax)}
              disabled={busy}
              onChange={(e) => setTaxBps(clampCreatorTaxBps(Number(e.target.value), maxTax))}
              aria-label="creator tax"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="initial buy (ETH)" error={quoteIn === null ? 'Not a valid ETH amount.' : undefined} hint="Optional. Bought in the launch transaction, exempt from the snipe tax.">
              <input className={`field ${quoteIn === null ? 'field-error' : ''}`} inputMode="decimal" value={initialBuy} disabled={busy} onChange={(e) => setInitialBuy(e.target.value)} placeholder="0.0" />
            </Field>
            <Field label="slippage (%)" error={slippageBps === null ? 'Between 0.1 and 20.' : undefined} hint="Applied to the initial buy.">
              <input className={`field ${slippageBps === null ? 'field-error' : ''}`} inputMode="decimal" value={slippage} disabled={busy} onChange={(e) => setSlippage(e.target.value)} placeholder="1" />
            </Field>
          </div>
          {plan !== null && plan.clamped && plan.quote !== null && (
            <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">
              This initial buy alone sells out the curve: you receive the whole sellable allocation, {formatEth(plan.quote.refund)} is refunded, and the coin
              graduates right away.
            </p>
          )}
          {quoteIn !== null && quoteIn > 0n && config !== null && settings !== undefined && plan === null && slippageBps !== null && (
            <p className="text-[12px] text-danger">The curve cannot price this initial buy (it rounds to zero tokens).</p>
          )}
        </section>

        {launch.error !== null && launch.error !== undefined && settings === undefined && !launch.loading && (
          <p className="rounded border border-danger/40 bg-danger/5 p-2 text-[12px] text-danger">Could not load the Pons launch configuration: {describeError(launch.error)}</p>
        )}
        {paused.data === true && <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">The registry is paused by its owner: new minds cannot be launched right now.</p>}
        {canLaunch.data === false && (
          <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">
            Pons does not accept launches from this registry yet (public launches are closed and the registry is not whitelisted). You can still adopt an existing Pons coin.
          </p>
        )}
        {touched && errors.schema !== undefined && <p className="text-[12px] text-danger">{errors.schema}</p>}
        {health.isError && fallback !== null && (
          <p className={`rounded border p-2 text-[12px] ${fallback.fits ? 'border-amber/40 bg-amber/5 text-amber' : 'border-danger/40 bg-danger/5 text-danger'}`}>
            The runner is not answering, so the metadata would be embedded on-chain as a data: URI ({fallback.bytes} / {METADATA_LIMITS.metadataUriBytes} bytes).
            {fallback.fits ? ' That fits.' : ' That is too large: shorten the persona or description, or try again when the runner is back.'}
          </p>
        )}
        {flowError !== null && <p className="rounded border border-danger/40 bg-danger/5 p-2 text-[12px] text-danger">{flowError}</p>}
        {launchTx.error !== null && step === 'form' && <p className="text-[12px] text-danger">{launchTx.error}</p>}

        <ChainGuard action="launch a coin">
          <button type="submit" className="btn btn-primary w-full py-3" disabled={busy || blocked || !amountsValid}>
            {submitLabel()}
          </button>
        </ChainGuard>
        {(published !== null || launchTx.hash !== undefined) && (
          <ol className="space-y-1 text-[12px] text-dim">
            {published !== null && (
              <li>
                <span className="text-acid">✓</span> metadata {published.result.via === 'runner' ? 'stored by the runner' : 'embedded as a data: URI (runner unreachable)'}
              </li>
            )}
            {launchTx.hash !== undefined && (
              <li>
                {launchedToken !== null ? <span className="text-acid">✓</span> : <span>…</span>} launchMind <TxLink hash={launchTx.hash} />
              </li>
            )}
          </ol>
        )}
      </form>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <section className="panel p-4">
          <p className="label">preview</p>
          <div className="flex items-start gap-3">
            <MindAvatar image={draft.image.trim() === '' ? null : draft.image.trim()} symbol={draft.symbol || '?'} size={48} />
            <div className="min-w-0">
              <p className="truncate text-fg">
                {draft.name.trim() || 'Unnamed'} <span className="text-dim">${ticker}</span>
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
              <dt>Pons launch fee</dt>
              <dd>{settings !== undefined ? formatEth(settings.launchFee) : launch.loading ? '…' : 'unavailable'}</dd>
            </div>
            <div className="kv">
              <dt>creation fee</dt>
              <dd>{creationFee.data !== undefined ? formatEth(creationFee.data) : REGISTRY_ADDRESS === null ? 'n/a' : creationFee.isError ? 'unavailable (RPC)' : '…'}</dd>
            </div>
            <div className="kv">
              <dt>initial buy</dt>
              <dd>{plan !== null ? formatEth(plan.quoteIn) : '—'}</dd>
            </div>
            {plan?.quote != null && (
              <>
                <div className="kv">
                  <dt>you receive ≈</dt>
                  <dd>
                    {formatTokens(plan.quote.tokensOut)} ${ticker}
                  </dd>
                </div>
                <div className="kv">
                  <dt>share of supply</dt>
                  <dd>{formatBps(plan.supplyShareBps)}</dd>
                </div>
                <div className="kv">
                  <dt>min received ({slippage || '0'}%)</dt>
                  <dd>{formatTokens(plan.minTokensOut)}</dd>
                </div>
                <div className="kv">
                  <dt>fee + creator tax</dt>
                  <dd>{formatEth(plan.quote.fee + plan.quote.tax)}</dd>
                </div>
              </>
            )}
            <div className="kv border-t border-line pt-2 text-fg">
              <dt className="text-fg">value sent</dt>
              <dd>{plan !== null ? formatEth(plan.value) : '—'}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] text-mute">
            value = Pons launch fee + initial buy + creation fee. The initial buy is quoted with the Pons curve math on the selected config&apos;s fresh curve
            (slippage {slippageBps !== null ? formatBps(slippageBps) : '—'}, default {formatBps(DEFAULT_SLIPPAGE_BPS)}); the launch terms are pinned with
            previewLaunchEconomics right before sending.
          </p>
        </section>
        <p className="text-[11px] text-mute">
          Prefer to look around first? <Link to="/">See the minds already running</Link>.
        </p>
      </aside>
    </div>
  );
}
