/** `/app/keys`: create (shown once with copy), list, revoke. */
import { useState, type FormEvent } from 'react';
import type { ApiKeyDto } from '@beagle/shared/api';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { Button, Card, Code, Field, Input, Note, PageHeader, TableWrap } from '../../components/ui.jsx';
import { useToast } from '../../hooks/useToast.jsx';
import { describeError } from '../../lib/errors.js';
import { maskKey } from '../../lib/keys.js';
import { formatDateTime, relativeTime } from '../../lib/time.js';
import { parseName } from '../../lib/validate.js';
import { useCreateKey, useKeys, useRevokeKey } from '../../queries.js';

/** API keys page. */
export function Keys() {
  const keys = useKeys();
  const create = useCreateKey();
  const revoke = useRevokeKey();
  const toast = useToast();
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<ApiKeyDto | undefined>(undefined);
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined);
  const parsedName = parseName(name);
  const now = Date.now();

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    if (parsedName === undefined) return;
    create.mutate(parsedName, {
      onSuccess: (k) => {
        setFresh(k);
        setName('');
        toast.push({ kind: 'success', title: 'Key created', message: 'Copy it now; it will not be shown again.' });
      },
      onError: (err) => toast.push({ kind: 'error', title: 'Could not create key', message: describeError(err) }),
    });
  };

  const onRevoke = (id: string) => {
    revoke.mutate(id, {
      onSuccess: () => {
        setConfirmId(undefined);
        toast.push({ kind: 'info', title: 'Key revoked' });
      },
      onError: (err) => toast.push({ kind: 'error', title: 'Could not revoke', message: describeError(err) }),
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="API keys" lead="Keys authenticate the inference API and the MCP server. The gateway stores only a hash: a key is shown once, at creation." />

      <Card title="Create a key">
        <form onSubmit={onCreate} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Name" error={parsedName === undefined ? 'At most 64 characters' : undefined} htmlFor="key-name">
              <Input id="key-name" placeholder="default" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={parsedName === undefined}>
            Create key
          </Button>
        </form>
        {fresh?.key !== undefined ? (
          <div className="mt-4 space-y-2">
            <Note tone="warn" title="Copy your new key now">
              This is the only time the full key is shown. Store it in a secret manager; use it as <span className="font-mono">Authorization: Bearer</span> or <span className="font-mono">x-api-key</span>.
            </Note>
            <Code code={fresh.key} title={`${fresh.name} · ${fresh.prefix}`} />
            <div className="text-right">
              <Button size="sm" variant="ghost" onClick={() => setFresh(undefined)}>
                I have copied it
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card title="Your keys">
        <QueryGuard query={keys} isEmpty={(d) => d.length === 0} empty={<p className="py-6 text-center text-sm text-muted">No keys yet.</p>}>
          {(list) => (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Name</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((k) => (
                    <tr key={k.id}>
                      <td className="font-mono text-xs">{maskKey(k.prefix)}</td>
                      <td>{k.name}</td>
                      <td className="text-muted">{formatDateTime(k.createdAt)}</td>
                      <td className="text-muted">{k.lastUsedAt === null ? 'never' : relativeTime(k.lastUsedAt, now)}</td>
                      <td className="text-right">
                        {confirmId === k.id ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="text-xs text-muted">Revoke?</span>
                            <Button size="sm" variant="danger" busy={revoke.isPending} onClick={() => onRevoke(k.id)}>
                              Yes, revoke
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmId(undefined)}>
                              No
                            </Button>
                          </span>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setConfirmId(k.id)}>
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </QueryGuard>
      </Card>
    </div>
  );
}
