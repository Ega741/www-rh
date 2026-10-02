/**
 * Mind identity: model, persona (from metadata) and the on-chain hashes it is bound to.
 *
 * @module components/MindInfoPanel
 */
import { useState } from 'react';
import { shortHash } from '../format';
import { personaHashOf } from '../lib/metadata';
import type { MindDetail } from '../lib/types';
import { modelLabel } from './MindCard';
import { CopyButton, Panel } from './common';

/** See module docs. */
export function MindInfoPanel({ mind }: { mind: MindDetail }) {
  const [expanded, setExpanded] = useState(false);
  const persona = mind.persona;
  const personaMatches = persona !== null ? personaHashOf(persona).toLowerCase() === mind.personaHash.toLowerCase() : null;
  const long = persona !== null && persona.length > 420;
  return (
    <Panel title="mind">
      <div className="space-y-3 p-3 text-[12px]">
        <dl>
          <div className="kv">
            <dt>model</dt>
            <dd className="text-fg">{modelLabel(mind)}</dd>
          </div>
          <div className="kv">
            <dt>modelId</dt>
            <dd className="text-mute" title={mind.modelId}>
              {shortHash(mind.modelId, 10)}
            </dd>
          </div>
          <div className="kv">
            <dt>personaHash</dt>
            <dd className="flex items-center gap-2 text-mute" title={mind.personaHash}>
              {shortHash(mind.personaHash, 10)} <CopyButton value={mind.personaHash} />
            </dd>
          </div>
        </dl>
        <div>
          <p className="label">persona</p>
          {persona === null ? (
            <p className="text-dim">The persona text could not be loaded from this coin's metadata. Its hash above is what the mind is bound to on-chain.</p>
          ) : (
            <>
              <p className={`whitespace-pre-wrap text-fg ${long && !expanded ? 'line-clamp-6' : ''}`}>{persona}</p>
              {long && (
                <button type="button" className="mt-1 text-[11px] text-mute hover:text-fg" onClick={() => setExpanded((e) => !e)}>
                  {expanded ? 'show less' : 'show all'}
                </button>
              )}
              <p className={`mt-1 text-[11px] ${personaMatches === true ? 'text-acid-dim' : 'text-amber'}`}>
                {personaMatches === true ? 'matches the on-chain personaHash' : 'does not match the on-chain personaHash'}
              </p>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
