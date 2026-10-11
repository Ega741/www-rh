/** `/app/upgrades`: Pro (price, days, current planUntil, buy) and Warm hours (hours, price, buy, window). */
import { useState } from 'react';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { Badge, Button, Card, Field, Input, Note, PageHeader, Stat, TableWrap } from '../../components/ui.jsx';
import { useToast } from '../../hooks/useToast.jsx';
import { fmtUsd } from '../../lib/amounts.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime, relativeTime } from '../../lib/time.js';
import { parseHours } from '../../lib/validate.js';
import { useBalance, useBuyUpgrade, useStatus, useUpgradePrices, useUpgrades } from '../../queries.js';

const MAX_WARM_HOURS = 168;

/** Upgrades page. */
export function Upgrades() {
  const prices = useUpgradePrices();
  const balance = useBalance();
  const status = useStatus();
  const upgrades = useUpgrades();
  const buy = useBuyUpgrade();
  const toast = useToast();
  const [hoursInput, setHoursInput] = useState('1');
  const hours = parseHours(hoursInput, MAX_WARM_HOURS);
  const now = Date.now();

  const available = balance.data?.availableMicro;
  const proPrice = prices.data?.pro.priceMicro;
  const warmPrice = prices.data?.warmHourPriceMicro;
  const warmTotal = warmPrice !== undefined && hours.ok ? warmPrice * BigInt(hours.hours) : undefined;

  const shortReason = (cost: bigint | undefined): string | undefined => {
    if (cost === undefined) return 'Prices are loading';
    if (available === undefined) return 'Balance is loading';
    if (available < cost) return `Needs ${fmtUsd(cost)} available; you have ${fmtUsd(available)}`;
    return undefined;
  };

  const onBuy = (kind: 'pro' | 'warm', quantity: number, label: string) => {
    buy.mutate(
      { kind, quantity },
      {
        onSuccess: (u) => toast.push({ kind: 'success', title: `${label} purchased`, message: `${fmtUsd(u.amountMicro)} charged · active until ${formatDateTime(u.endsAt)}` }),
        onError: (err) => toast.push({ kind: 'error', title: `Could not buy ${label}`, message: describeError(err) }),
      },
    );
  };

  const proReason = shortReason(proPrice);
  const warmReason = hours.ok ? shortReason(warmTotal) : hours.error;
  const houseEnabled = status.data?.house.enabled ?? true;
  const warmUntil = status.data?.house.warmUntil ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title="Upgrades" lead="Paid from your credit balance; no tokens move. Pro extends from the current plan end; warm hours extend from the current warm window." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pro" actions={<Badge tone="accent">plan</Badge>}>
          <QueryGuard query={prices}>
            {(p) => (
              <div className="space-y-3">
                <p className="font-mono text-2xl font-semibold">
                  {fmtUsd(p.pro.priceMicro)} <span className="text-sm text-muted">/ {p.pro.days} days</span>
                </p>
                <ul className="list-disc pl-5 text-sm text-muted">
                  <li>
                    House model <span className="font-mono text-fg">{status.data?.house.largeModel ?? 'gpt-oss-120b'}</span> and 128K house context
                  </li>
                  <li>Higher rate limit on every key</li>
                </ul>
                <QueryGuard query={balance}>
                  {(b) => (
                    <div className="grid grid-cols-2 gap-3">
                      <Stat label="Current plan" value={b.plan === 'pro' ? 'Pro' : 'Free'} mono={false} />
                      <Stat label={b.plan === 'pro' ? 'Pro until' : 'Available'} value={b.plan === 'pro' && b.planUntil !== null ? formatDateTime(b.planUntil) : fmtUsd(b.availableMicro)} sub={b.plan === 'pro' && b.planUntil !== null ? relativeTime(b.planUntil, now) : undefined} />
                    </div>
                  )}
                </QueryGuard>
                <Button variant="primary" busy={buy.isPending && buy.variables?.kind === 'pro'} disabled={proReason !== undefined} reason={proReason} onClick={() => onBuy('pro', 1, 'Pro')}>
                  {balance.data?.plan === 'pro' ? `Extend Pro by ${p.pro.days} days` : `Buy Pro for ${fmtUsd(p.pro.priceMicro)}`}
                </Button>
                {proReason !== undefined && !prices.isPending && !balance.isPending ? <p className="text-xs text-muted">{proReason}</p> : null}
              </div>
            )}
          </QueryGuard>
        </Card>

        <Card title="Warm hours" actions={<Badge tone="info">GPU</Badge>}>
          <QueryGuard query={prices}>
            {(p) => (
              <div className="space-y-3">
                <p className="font-mono text-2xl font-semibold">
                  {fmtUsd(p.warmHourPriceMicro)} <span className="text-sm text-muted">/ hour</span>
                </p>
                <p className="text-sm text-muted">Keeps the house GPU loaded so requests never wait for a cold start. Hours stack onto the current warm window.</p>
                {!houseEnabled ? (
                  <Note tone="warn" title="House model is not enabled on this gateway">
                    Warm hours have no effect until the operator configures a house endpoint.
                  </Note>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Warm until" value={warmUntil === null ? 'not warm' : formatDateTime(warmUntil)} sub={warmUntil === null ? undefined : relativeTime(warmUntil, now)} mono={warmUntil !== null} />
                  <Stat label="Total" value={warmTotal === undefined ? '—' : fmtUsd(warmTotal)} sub={hours.ok ? `${hours.hours} h` : undefined} />
                </div>
                <Field label="Hours (1–168)" error={hours.ok ? undefined : hours.error} htmlFor="warm-hours">
                  <Input id="warm-hours" mono inputMode="numeric" value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} className="w-32" />
                </Field>
                <Button variant="primary" busy={buy.isPending && buy.variables?.kind === 'warm'} disabled={warmReason !== undefined} reason={warmReason} onClick={() => hours.ok && onBuy('warm', hours.hours, `${hours.hours} warm hour${hours.hours === 1 ? '' : 's'}`)}>
                  {warmTotal === undefined ? 'Buy warm hours' : `Buy for ${fmtUsd(warmTotal)}`}
                </Button>
                {warmReason !== undefined && hours.ok && !prices.isPending && !balance.isPending ? <p className="text-xs text-muted">{warmReason}</p> : null}
              </div>
            )}
          </QueryGuard>
        </Card>
      </div>

      <Card title="History">
        <QueryGuard query={upgrades} isEmpty={(d) => d.length === 0} empty={<p className="py-6 text-center text-sm text-muted">No upgrades purchased yet.</p>}>
          {(list) => (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Bought</th>
                    <th>Kind</th>
                    <th>Quantity</th>
                    <th>Charged</th>
                    <th>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {[...list]
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((u) => (
                      <tr key={u.id}>
                        <td className="text-muted">{formatDateTime(u.createdAt)}</td>
                        <td>
                          <Badge tone={u.kind === 'pro' ? 'accent' : 'info'}>{u.kind}</Badge>
                        </td>
                        <td className="font-mono">{u.kind === 'pro' ? `${u.quantity} period${u.quantity === 1 ? '' : 's'}` : `${u.quantity} h`}</td>
                        <td className="font-mono">{fmtUsd(u.amountMicro)}</td>
                        <td className="text-muted">
                          {formatDateTime(u.startsAt)} → {formatDateTime(u.endsAt)}
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
