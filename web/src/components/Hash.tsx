/** Public keys, signatures and hashes with explorer links and copy. */
import { config } from '../config.js';
import { addressLink, shortAddress, shortHash, shortSignature, txLink } from '../lib/explorer.js';
import { CopyButton } from './ui.jsx';

/** Public key shortened (`Abcd…wxyz`) and linked to the explorer. */
export function AddressText({ address, full = false, copy = false }: { address: string; full?: boolean; copy?: boolean }) {
  const text = full ? address : shortAddress(address);
  const href = addressLink(config.cluster, address, config.rpcUrl);
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[0.92em]">
      <a className="link" href={href} target="_blank" rel="noreferrer" title={address}>
        {text}
      </a>
      {copy ? <CopyButton text={address} /> : null}
    </span>
  );
}

/** Transaction signature with explorer link (`href` overrides the built link, e.g. `CreditEventDto.explorerUrl`). */
export function TxLink({ signature, label, href }: { signature: string; label?: string; href?: string | null | undefined }) {
  const url = href ?? txLink(config.cluster, signature, config.rpcUrl);
  const text = label ?? shortSignature(signature);
  return (
    <a className="link font-mono text-[0.92em]" href={url} target="_blank" rel="noreferrer" title={signature}>
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
