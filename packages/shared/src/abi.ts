/**
 * Contract ABIs (`as const`, viem-typed) and the helper types derived from them.
 *
 * `CREDIT_DESK_ABI`, `BEAGLE_TOKEN_ABI`, `MANUAL_PRICE_SOURCE_ABI` and `CHAINLINK_PRICE_SOURCE_ABI`
 * come from `abi.generated.ts` (written by `scripts/sync-abi.mjs` from the Foundry build output);
 * `ERC20_ABI` is a hand-written minimal ERC-20 subset for arbitrary credit tokens.
 *
 * @module abi
 */
import {
  getAbiItem,
  type AbiParameter,
  type AbiParameterToPrimitiveType,
  type ContractFunctionReturnType,
  type GetEventArgs,
} from 'viem';
import {
  BEAGLE_TOKEN_ABI,
  CHAINLINK_PRICE_SOURCE_ABI,
  CREDIT_DESK_ABI,
  MANUAL_PRICE_SOURCE_ABI,
} from './abi.generated.js';

export { BEAGLE_TOKEN_ABI, CHAINLINK_PRICE_SOURCE_ABI, CREDIT_DESK_ABI, MANUAL_PRICE_SOURCE_ABI };

/** Minimal ERC-20 ABI (metadata, balances, allowances, transfers and the two standard events). */
export const ERC20_ABI = [
  { type: 'function', name: 'name', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transferFrom',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const;

/** Type of {@link CREDIT_DESK_ABI}. */
export type CreditDeskAbi = typeof CREDIT_DESK_ABI;
/** Type of {@link BEAGLE_TOKEN_ABI}. */
export type BeagleTokenAbi = typeof BEAGLE_TOKEN_ABI;
/** Type of {@link MANUAL_PRICE_SOURCE_ABI}. */
export type ManualPriceSourceAbi = typeof MANUAL_PRICE_SOURCE_ABI;
/** Type of {@link CHAINLINK_PRICE_SOURCE_ABI}. */
export type ChainlinkPriceSourceAbi = typeof CHAINLINK_PRICE_SOURCE_ABI;
/** Type of {@link ERC20_ABI}. */
export type Erc20Abi = typeof ERC20_ABI;

/** Maps a tuple of ABI parameters to the tuple of their TypeScript primitive types. */
export type AbiParametersToPrimitiveTypes<T extends readonly AbiParameter[]> = {
  [K in keyof T]: T[K] extends AbiParameter ? AbiParameterToPrimitiveType<T[K]> : never;
};

/** The four `CreditDesk` events the gateway indexer consumes (SPEC §3.4, §5.4). */
export const CREDIT_DESK_EVENT_NAMES = ['CreditPurchased', 'BudgetOpened', 'BudgetDrawn', 'BudgetClosed'] as const;

/** One of {@link CREDIT_DESK_EVENT_NAMES}. */
export type CreditDeskEventName = (typeof CREDIT_DESK_EVENT_NAMES)[number];

/** Event argument options: all parameters (indexed or not), named, required. */
type StrictEventArgs = { EnableUnion: false; IndexedOnly: false; Required: true };

/** Decoded, fully populated arguments of a `CreditDesk` event. */
export type CreditDeskEventArgs<N extends CreditDeskEventName> = GetEventArgs<CreditDeskAbi, N, StrictEventArgs>;

/** `CreditPurchased(receiptId, workspace, payer, tokenAmount, usdMicro, priceE18)`. */
export type CreditPurchasedArgs = CreditDeskEventArgs<'CreditPurchased'>;
/** `BudgetOpened(budgetId, owner, workspace, cap, deadline)`. */
export type BudgetOpenedArgs = CreditDeskEventArgs<'BudgetOpened'>;
/** `BudgetDrawn(budgetId, receiptId, workspace, tokenAmount, usdMicro, priceE18, receiptHash)`. */
export type BudgetDrawnArgs = CreditDeskEventArgs<'BudgetDrawn'>;
/** `BudgetClosed(budgetId, drawn)`. */
export type BudgetClosedArgs = CreditDeskEventArgs<'BudgetClosed'>;

/** `PricePosted(priceE18, updatedAt, poster)` of `ManualPriceSource`. */
export type PricePostedArgs = GetEventArgs<ManualPriceSourceAbi, 'PricePosted', StrictEventArgs>;

/** Return tuple of `CreditDesk.quote(amount)`: `[usdMicro, priceE18, updatedAt]`. */
export type QuoteResult = ContractFunctionReturnType<CreditDeskAbi, 'view', 'quote'>;
/** Return tuple of the `CreditDesk.budgets(id)` getter: `[owner, workspace, cap, drawn, deadline, closed]`. */
export type BudgetTuple = ContractFunctionReturnType<CreditDeskAbi, 'view', 'budgets'>;
/** Return tuple of `IPriceSource.latestPrice()`: `[priceE18, updatedAt]`. */
export type LatestPriceResult = ContractFunctionReturnType<ManualPriceSourceAbi, 'view', 'latestPrice'>;

/** The `Budget` struct of `CreditDesk` as a named object. */
export interface BudgetStruct {
  owner: `0x${string}`;
  workspace: `0x${string}`;
  cap: bigint;
  drawn: bigint;
  deadline: bigint;
  closed: boolean;
}

/** Converts the positional `budgets(id)` getter result into a {@link BudgetStruct}. */
export function toBudgetStruct(tuple: BudgetTuple): BudgetStruct {
  const [owner, workspace, cap, drawn, deadline, closed] = tuple;
  return { owner, workspace, cap, drawn, deadline, closed };
}

/** The ABI items of the indexed `CreditDesk` events, keyed by name (for `getLogs({ events })`). */
export const CREDIT_DESK_EVENTS = {
  CreditPurchased: getAbiItem({ abi: CREDIT_DESK_ABI, name: 'CreditPurchased' }),
  BudgetOpened: getAbiItem({ abi: CREDIT_DESK_ABI, name: 'BudgetOpened' }),
  BudgetDrawn: getAbiItem({ abi: CREDIT_DESK_ABI, name: 'BudgetDrawn' }),
  BudgetClosed: getAbiItem({ abi: CREDIT_DESK_ABI, name: 'BudgetClosed' }),
} as const;

/** The ABI items of {@link CREDIT_DESK_EVENTS} as a list, in {@link CREDIT_DESK_EVENT_NAMES} order. */
export const CREDIT_DESK_EVENT_ITEMS = [
  CREDIT_DESK_EVENTS.CreditPurchased,
  CREDIT_DESK_EVENTS.BudgetOpened,
  CREDIT_DESK_EVENTS.BudgetDrawn,
  CREDIT_DESK_EVENTS.BudgetClosed,
] as const;

/** `true` when `name` is one of {@link CREDIT_DESK_EVENT_NAMES}. */
export function isCreditDeskEventName(name: string): name is CreditDeskEventName {
  return (CREDIT_DESK_EVENT_NAMES as readonly string[]).includes(name);
}
