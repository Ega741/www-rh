/** Addresses and hashes with explorer links and copy. */
import type { Chain } from 'viem';
import { config } from '../config.js';
import { addressLink, checksum, shortAddress, shortHash, txLink } from '../lib/explorer.js';
import { CopyButton } from './ui.jsx';

/** Address shortened, checksummed, linked to the explorer when one exists. */
export function AddressText({ address, chain = config.chain, full = false, copy = false }: { address: string; chain?: Chain; full?: boolean; copy?: boolean }) {
  const text = full ? checksum(address) : shortAddress(address);
  const href = addressLink(chain, address);
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[0.92em]">
      {href === undefined ? (
        <span title={checksum(address)}>{text}</span>
      ) : (
        <a className="link" href={href} target="_blank" rel="noreferrer" title={checksum(address)}>
          {text}
        </a>
      )}
      {copy ? <CopyButton text={checksum(address)} /> : null}
    </span>
  );
}

/** Transaction hash with explorer link. */
export function TxLink({ hash, chain = config.chain, label }: { hash: string; chain?: Chain; label?: string }) {
  const href = txLink(chain, hash);
  const text = label ?? shortHash(hash);
  if (href === undefined) {
    return (
      <span className="font-mono text-[0.92em]" title={hash}>
        {text}
      </span>
    );
  }
  return (
    <a className="link font-mono text-[0.92em]" href={href} target="_blank" rel="noreferrer" title={hash}>
      {text}
    </a>
  );
}

/** Any 0x hash shortened with copy. */
export function HashText({ hash, copy = true }: { hash: string; copy?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[0.92em]" title={hash}>
      {shortHash(hash, 10, 6)}
      {copy ? <CopyButton text={hash} /> : null}
    </span>
  );
}
