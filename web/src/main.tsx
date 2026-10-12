// The Buffer polyfill must be installed before `@solana/web3.js` (or anything importing it) loads.
import { Buffer } from 'buffer';
globalThis.Buffer ??= Buffer;

const { bootstrap } = await import('./bootstrap.js');
bootstrap();
