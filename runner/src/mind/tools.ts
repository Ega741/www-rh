/**
 * The mind's tools (`docs/SPEC.md` §4.1 `mind/tools.ts`): `betaZodTool` definitions spread with
 * `eager_input_streaming: true`, in a fixed order with fixed descriptions (no per-mind text), so the
 * serialized tools array is byte-identical for every mind and tick (prompt-cache friendly). Schemas
 * and descriptions are module constants created once per process; each tick only binds `run` to the
 * mind's context (asserted by a unit test on the serialized definitions).
 * Expected failures are returned as text results starting with `error:`; `run` never throws.
 *
 * @module mind/tools
 */
import type Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Memory } from '@www-rh/shared';
import type { EgressFilter } from '../browser/egress.js';
import type { MindBrowserApi } from '../browser/mindBrowser.js';
import { errorMessage } from '../log.js';

/** What the tools need from the tick. */
export interface ToolContext {
  /** The mind's browser session (created lazily). */
  browser(): Promise<MindBrowserApi>;
  egress: EgressFilter;
  remember(kind: 'note' | 'finding', content: string, url: string | null): Memory;
  recall(query: string, limit: number): Memory[];
  thinkAloud(text: string): void;
  /** Called after every browser action (frame capture, current URL). */
  afterAction(): void;
}

const httpUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\/\S+$/i, 'must be an http(s) URL')
  .describe('Absolute http(s) URL');

/** Input schemas (zod) of every tool, in tool order. */
export const toolSchemas = {
  browse_navigate: z.object({ url: httpUrl }),
  browse_read: z.object({}),
  browse_click: z
    .object({
      link: z.number().int().min(0).optional().describe('Index `i` of a link from the last read result'),
      selector: z.string().min(1).max(300).optional().describe('CSS selector of the element to click'),
    })
    .refine((v) => (v.link === undefined) !== (v.selector === undefined), 'provide exactly one of `link` or `selector`'),
  browse_type: z.object({
    selector: z.string().min(1).max(300).describe('CSS selector of the input'),
    text: z.string().max(500).describe('Text to type (never personal data)'),
    submit: z.boolean().optional().describe('Press Enter afterwards'),
  }),
  browse_scroll: z.object({ direction: z.enum(['up', 'down']) }),
  browse_back: z.object({}),
  browse_screenshot: z.object({}),
  remember: z.object({
    kind: z.enum(['note', 'finding']).describe('"finding" for verified facts, "note" for plans and impressions'),
    content: z.string().min(1).max(2000),
    url: httpUrl.optional().describe('Source URL, if any'),
  }),
  recall: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(20).optional().describe('Default 8'),
  }),
  think_aloud: z.object({ text: z.string().min(1).max(280) }),
} as const;

/** Tool names in their fixed order. */
export const TOOL_NAMES = Object.keys(toolSchemas) as (keyof typeof toolSchemas)[];

const DESCRIPTIONS: Record<keyof typeof toolSchemas, string> = {
  browse_navigate: 'Open a URL in your browser. Call this to visit a page you want to read. Returns the page text and numbered links.',
  browse_read: 'Read the current page again (text and numbered links). Call this after the page changed or to refresh the link numbers.',
  browse_click: 'Click a link by its number from the last read result, or an element by CSS selector. Returns the resulting page.',
  browse_type: 'Type text into an input (e.g. a search box) selected by CSS selector, optionally pressing Enter. Never type personal data.',
  browse_scroll: 'Scroll the current page up or down by most of a screen and return what is visible to the text extractor.',
  browse_back: 'Go back to the previous page in your browser history.',
  browse_screenshot: 'Take a screenshot of what your browser shows. Call this when the layout, images or charts matter.',
  remember: 'Store something in your long-term memory. Call this whenever you learn something worth keeping or decide on a plan.',
  recall: 'Search your long-term memory. Call this before revisiting a topic to avoid repeating yourself.',
  think_aloud: 'Share a short public thought with the people watching you (one or two sentences).',
};

const asText = (value: unknown): string => JSON.stringify(value);

async function guarded(fn: () => Promise<string | Anthropic.Beta.Messages.BetaToolResultContentBlockParam[]>): Promise<string | Anthropic.Beta.Messages.BetaToolResultContentBlockParam[]> {
  try {
    return await fn();
  } catch (err) {
    return `error: ${errorMessage(err)}`;
  }
}

/** Builds the runnable tools bound to `ctx` (byte-identical definitions for every mind). */
export function createMindTools(ctx: ToolContext) {
  const browse = async (action: (b: MindBrowserApi) => Promise<unknown>): Promise<string> => {
    const b = await ctx.browser();
    try {
      return asText(await action(b));
    } finally {
      ctx.afterAction();
    }
  };
  const tools = [
    betaZodTool({
      name: 'browse_navigate',
      description: DESCRIPTIONS.browse_navigate,
      inputSchema: toolSchemas.browse_navigate,
      run: (input) =>
        guarded(async () => {
          const verdict = await ctx.egress.checkUrl(input.url);
          if (!verdict.ok) return `error: blocked URL (${verdict.reason})`;
          return browse((b) => b.navigate(input.url));
        }),
    }),
    betaZodTool({ name: 'browse_read', description: DESCRIPTIONS.browse_read, inputSchema: toolSchemas.browse_read, run: () => guarded(() => browse((b) => b.read())) }),
    betaZodTool({
      name: 'browse_click',
      description: DESCRIPTIONS.browse_click,
      inputSchema: toolSchemas.browse_click,
      run: (input) => guarded(() => browse((b) => b.click(input.link !== undefined ? { link: input.link } : { selector: input.selector as string }))),
    }),
    betaZodTool({
      name: 'browse_type',
      description: DESCRIPTIONS.browse_type,
      inputSchema: toolSchemas.browse_type,
      run: (input) => guarded(() => browse((b) => b.type(input.selector, input.text, input.submit === true))),
    }),
    betaZodTool({ name: 'browse_scroll', description: DESCRIPTIONS.browse_scroll, inputSchema: toolSchemas.browse_scroll, run: (input) => guarded(() => browse((b) => b.scroll(input.direction))) }),
    betaZodTool({ name: 'browse_back', description: DESCRIPTIONS.browse_back, inputSchema: toolSchemas.browse_back, run: () => guarded(() => browse((b) => b.back())) }),
    betaZodTool({
      name: 'browse_screenshot',
      description: DESCRIPTIONS.browse_screenshot,
      inputSchema: toolSchemas.browse_screenshot,
      run: () =>
        guarded(async () => {
          const b = await ctx.browser();
          const data = await b.screenshot();
          ctx.afterAction();
          return [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }];
        }),
    }),
    betaZodTool({
      name: 'remember',
      description: DESCRIPTIONS.remember,
      inputSchema: toolSchemas.remember,
      run: (input) => guarded(async () => asText({ seq: ctx.remember(input.kind, input.content, input.url ?? null).seq })),
    }),
    betaZodTool({
      name: 'recall',
      description: DESCRIPTIONS.recall,
      inputSchema: toolSchemas.recall,
      run: (input) =>
        guarded(async () => asText(ctx.recall(input.query, input.limit ?? 8).map((m) => ({ seq: m.seq, kind: m.kind, content: m.content, url: m.url, createdAt: m.createdAt })))),
    }),
    betaZodTool({
      name: 'think_aloud',
      description: DESCRIPTIONS.think_aloud,
      inputSchema: toolSchemas.think_aloud,
      run: (input) =>
        guarded(async () => {
          ctx.thinkAloud(input.text);
          return 'ok';
        }),
    }),
  ];
  return tools.map((tool) => ({ ...tool, eager_input_streaming: true as const }));
}

/** The runnable tool type passed to the tool runner. */
export type MindTool = ReturnType<typeof createMindTools>[number];

/** Serialized tool definitions as sent to the API (functions dropped) — for cache-stability checks. */
export function serializeToolDefinitions(tools: readonly MindTool[]): string {
  return JSON.stringify(tools);
}
