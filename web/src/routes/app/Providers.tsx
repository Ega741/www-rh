/** `/app/providers`: BYOK add / replace / remove / test per provider; https-only base URL. */
import { useState, type FormEvent } from 'react';
import type { ProviderKeyDto, ProviderTestDto } from '@beagle/shared/api';
import { BYOK_PROVIDERS, type ByokProvider } from '@beagle/shared/models';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { Badge, Button, Card, Field, Input, Note, PageHeader } from '../../components/ui.jsx';
import { useToast } from '../../hooks/useToast.jsx';
import { describeError } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/time.js';
import { isHttpsUrl } from '../../lib/validate.js';
import { usePutProvider, useProviders, useRemoveProvider, useTestProvider } from '../../queries.js';

const PROVIDER_META: Record<ByokProvider, { name: string; keyHint: string; baseHint: string }> = {
  anthropic: { name: 'Anthropic', keyHint: 'sk-ant-…', baseHint: 'default: https://api.anthropic.com' },
  openai: { name: 'OpenAI', keyHint: 'sk-…', baseHint: 'default: https://api.openai.com/v1 (any OpenAI-compatible https endpoint)' },
  google: { name: 'Google Gemini', keyHint: 'AIza…', baseHint: 'default: https://generativelanguage.googleapis.com/v1beta/openai' },
};

function ProviderCard({ provider, current }: { provider: ByokProvider; current: ProviderKeyDto | undefined }) {
  const meta = PROVIDER_META[provider];
  const toast = useToast();
  const put = usePutProvider();
  const remove = useRemoveProvider();
  const test = useTestProvider();
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [editing, setEditing] = useState(current === undefined);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [lastTest, setLastTest] = useState<ProviderTestDto | undefined>(undefined);

  const baseTrim = baseUrl.trim();
  const baseError = baseTrim !== '' && !isHttpsUrl(baseTrim) ? 'Base URL must be an absolute https:// URL' : undefined;
  const keyError = apiKey !== '' && apiKey.trim().length < 8 ? 'Key looks too short' : undefined;
  const canSave = apiKey.trim().length >= 8 && baseError === undefined;

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    put.mutate(
      { provider, apiKey: apiKey.trim(), ...(baseTrim === '' ? {} : { baseUrl: baseTrim }) },
      {
        onSuccess: () => {
          setApiKey('');
          setBaseUrl('');
          setEditing(false);
          setLastTest(undefined);
          toast.push({ kind: 'success', title: `${meta.name} key saved`, message: 'Encrypted at rest; requests through it consume no credit.' });
        },
        onError: (err) => toast.push({ kind: 'error', title: 'Could not save key', message: describeError(err) }),
      },
    );
  };

  const onTest = () => {
    test.mutate(provider, {
      onSuccess: (r) => {
        setLastTest(r);
        toast.push({ kind: r.ok ? 'success' : 'error', title: r.ok ? `${meta.name} key works` : `${meta.name} test failed`, message: r.ok ? `${r.model ?? 'model'} answered in ${r.latencyMs} ms` : r.error ?? 'unknown error' });
      },
      onError: (err) => toast.push({ kind: 'error', title: 'Test failed', message: describeError(err) }),
    });
  };

  const onRemove = () => {
    remove.mutate(provider, {
      onSuccess: () => {
        setConfirmRemove(false);
        setEditing(true);
        setLastTest(undefined);
        toast.push({ kind: 'info', title: `${meta.name} key removed` });
      },
      onError: (err) => toast.push({ kind: 'error', title: 'Could not remove key', message: describeError(err) }),
    });
  };

  return (
    <Card
      title={meta.name}
      actions={current === undefined ? <Badge>platform key</Badge> : current.lastError !== null ? <Badge tone="err">key error</Badge> : <Badge tone="ok">BYOK active</Badge>}
    >
      {current !== undefined ? (
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Key</dt>
          <dd className="font-mono">••••{current.last4}</dd>
          <dt className="text-muted">Base URL</dt>
          <dd className="break-all font-mono text-xs">{current.baseUrl ?? 'provider default'}</dd>
          <dt className="text-muted">Added</dt>
          <dd>{formatDateTime(current.createdAt)}</dd>
          {current.lastError !== null ? (
            <>
              <dt className="text-muted">Last error</dt>
              <dd className="text-xs text-err">{current.lastError}</dd>
            </>
          ) : null}
          {lastTest !== undefined ? (
            <>
              <dt className="text-muted">Last test</dt>
              <dd className={`text-xs ${lastTest.ok ? 'text-ok' : 'text-err'}`}>{lastTest.ok ? `ok · ${lastTest.model ?? ''} · ${lastTest.latencyMs} ms` : lastTest.error ?? 'failed'}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {editing ? (
        <form onSubmit={onSave} className="space-y-3">
          <Field label="API key" error={keyError} htmlFor={`${provider}-key`}>
            <Input id={`${provider}-key`} type="password" mono autoComplete="off" placeholder={meta.keyHint} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Field>
          <Field label="Base URL (optional, https only)" error={baseError} hint={meta.baseHint} htmlFor={`${provider}-base`}>
            <Input id={`${provider}-base`} mono inputMode="url" placeholder="https://" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" busy={put.isPending} disabled={!canSave} reason={canSave ? undefined : 'Enter a key (and a valid https URL)'}>
              {current === undefined ? 'Save key' : 'Replace key'}
            </Button>
            {current !== undefined ? (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button busy={test.isPending} onClick={onTest}>
            Test
          </Button>
          <Button onClick={() => setEditing(true)}>Replace</Button>
          {confirmRemove ? (
            <>
              <Button variant="danger" busy={remove.isPending} onClick={onRemove}>
                Confirm remove
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Providers (BYOK) page. */
export function Providers() {
  const providers = useProviders();
  return (
    <div className="space-y-6">
      <PageHeader title="Your provider keys" lead="Bring your own keys: requests routed to a provider you hold a key for are served through it and consume no credit (the router prefers BYOK candidates). Keys are encrypted at rest with AES-256-GCM and decrypted only in the request path; only the last four characters are ever shown again." />
      <Note tone="info" title="How BYOK affects routing">
        A workspace key for a provider makes that provider's models <span className="font-mono">paidBy: byok</span>. A 401 from your key is flagged here and does not affect other workspaces; platform keys stay in use for providers you have not configured.
      </Note>
      <QueryGuard query={providers}>
        {(list) => (
          <div className="grid gap-4 lg:grid-cols-3">
            {BYOK_PROVIDERS.map((p) => (
              <ProviderCard key={p} provider={p} current={list.find((x) => x.provider === p)} />
            ))}
          </div>
        )}
      </QueryGuard>
    </div>
  );
}
