#!/usr/bin/env node
/**
 * `beagle-mcp` stdio entry point; the logic lives in `cli.ts` so it can be imported and tested.
 *
 * @module bin
 */
import { main } from './cli.js';

main().catch((error: unknown) => {
  process.stderr.write(`[beagle-mcp] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
