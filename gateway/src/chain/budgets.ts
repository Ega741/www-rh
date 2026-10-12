/**
 * Budget scanner (SPEC §3.4, §5.4): budgets are SPL token accounts of the mint delegated to the
 * operator. `scan()` discovers them with `getProgramAccounts` (classic Token program: 165-byte
 * accounts, `mint` at offset 0, `delegate` at offset 76; Token-2022 accounts are found per owner
 * with `getTokenAccountsByOwner`), `refresh()` re-reads every open budget with
 * `getMultipleAccountsInfo` and recomputes `headroom_tokens = delegate == operator ?
 * min(delegatedAmount, amount) : 0` and `headroom_micro` at the current price, and `register()`
 * inserts a budget right after `POST /api/budgets/register` (validating mint and delegate).
 *
 * @module chain/budgets
 */
import { TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { quoteUsdMicro } from '@beagle/shared/credit';
import { TOKEN_ACCOUNT_DELEGATE_OFFSET, TOKEN_ACCOUNT_MINT_OFFSET, TOKEN_ACCOUNT_SIZE } from '@beagle/shared/solana';
import type { BudgetRow, BudgetStalledReason, Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import type { PriceService, PriceSnapshot } from './price.js';
import { parseTokenAccount, type ChainReader, type RpcAccountFilter, type TokenAccountState } from './rpc.js';

/** Options of {@link BudgetScanner}. */
export interface BudgetScannerOptions {
  mint: string;
  /** The delegate every budget must name; `undefined` → no budget can be open. */
  operator: string | undefined;
  tokenProgram: string;
  decimals: number;
  /** Accounts per `getMultipleAccountsInfo` call (RPC maximum 100). */
  batchSize?: number;
  now?: () => number;
}

/** What {@link computeHeadroom} decides for one account. */
export interface HeadroomDecision {
  closed: boolean;
  headroomTokens: bigint;
  headroomMicro: bigint;
  stalledReason: BudgetStalledReason | null;
}

/** `getProgramAccounts` filters of the §3.4 scan. */
export function budgetScanFilters(mint: string, operator: string): RpcAccountFilter[] {
  return [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mint } }, { memcmp: { offset: TOKEN_ACCOUNT_DELEGATE_OFFSET, bytes: operator } }];
}

/**
 * Pure headroom rule (SPEC §5.4): `delegate != operator` → closed (`revoked`); otherwise
 * `min(delegatedAmount, amount)` tokens, quoted at `price` (stale or missing price → 0 µUSD,
 * `price`); zero tokens with the delegate in place → `exhausted`.
 */
export function computeHeadroom(state: Pick<TokenAccountState, 'delegate' | 'delegatedAmount' | 'amount'>, operator: string | undefined, price: PriceSnapshot | undefined, decimals: number): HeadroomDecision {
  if (operator === undefined || state.delegate !== operator) return { closed: true, headroomTokens: 0n, headroomMicro: 0n, stalledReason: 'revoked' };
  const headroomTokens = state.delegatedAmount < state.amount ? state.delegatedAmount : state.amount;
  if (price === undefined || price.stale) return { closed: false, headroomTokens, headroomMicro: 0n, stalledReason: 'price' };
  if (headroomTokens === 0n) return { closed: false, headroomTokens, headroomMicro: 0n, stalledReason: 'exhausted' };
  return { closed: false, headroomTokens, headroomMicro: quoteUsdMicro(headroomTokens, price.priceE18, decimals), stalledReason: null };
}

/** Why `POST /api/budgets/register` refused the account. */
export type BudgetRegisterCode = 'not_found' | 'not_token_account' | 'wrong_mint' | 'not_delegated';

/** Thrown by {@link BudgetScanner.register}. */
export class BudgetRegisterError extends Error {
  override readonly name = 'BudgetRegisterError';
  constructor(
    readonly code: BudgetRegisterCode,
    message: string,
  ) {
    super(message);
  }
}

/** Discovers and refreshes budgets. */
export class BudgetScanner {
  private readonly now: () => number;
  private warnedToken2022 = false;

  constructor(
    private readonly repos: Repos,
    private readonly reader: ChainReader,
    private readonly price: PriceService,
    private readonly options: BudgetScannerOptions,
    private readonly logger: Logger,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Applies on-chain facts of a token account to its budget row (upsert + headroom). */
  applyState(state: TokenAccountState, slot?: number, extra: { workspace?: string; registeredAt?: number } = {}): BudgetRow {
    const now = this.now();
    return this.repos.transaction(() => {
      this.repos.budgets.upsert({
        tokenAccount: state.address,
        owner: state.owner,
        delegate: state.delegate,
        cap: state.delegatedAmount,
        balance: state.amount,
        now,
        ...(slot === undefined ? {} : { lastSeenSlot: slot }),
        ...(extra.workspace === undefined ? {} : { workspace: extra.workspace }),
        ...(extra.registeredAt === undefined ? {} : { registeredAt: extra.registeredAt }),
      });
      const decision = computeHeadroom(state, this.options.operator, this.price.current(), this.options.decimals);
      if (decision.closed) this.repos.budgets.setClosed(state.address, true, decision.stalledReason, now);
      else {
        const before = this.repos.budgets.get(state.address);
        if (before?.closed === true) this.repos.budgets.setClosed(state.address, false, null, now);
        this.repos.budgets.setHeadroom(state.address, decision.headroomTokens, decision.headroomMicro, decision.stalledReason, now);
      }
      return this.repos.budgets.get(state.address) as BudgetRow;
    });
  }

  /** The account vanished (closed): the budget is closed as `revoked`. */
  markMissing(tokenAccount: string): void {
    const now = this.now();
    this.repos.transaction(() => {
      this.repos.budgets.upsert({ tokenAccount, owner: this.repos.budgets.get(tokenAccount)?.owner ?? tokenAccount, delegate: null, cap: 0n, balance: 0n, now });
      this.repos.budgets.setClosed(tokenAccount, true, 'revoked', now);
    });
  }

  /**
   * Discovery scan: every token account of the mint delegated to the operator (classic Token
   * program via `getProgramAccounts`; Token-2022 via `getTokenAccountsByOwner` of known owners).
   * Returns the number of accounts seen.
   */
  async scan(): Promise<number> {
    const operator = this.options.operator;
    if (operator === undefined) return 0;
    let entries: { pubkey: string; account: Parameters<typeof parseTokenAccount>[1] }[];
    if (this.options.tokenProgram === TOKEN_PROGRAM_ID) {
      entries = await this.reader.getParsedProgramAccounts(this.options.tokenProgram, budgetScanFilters(this.options.mint, operator));
    } else {
      if (!this.warnedToken2022) {
        this.logger.info('Token-2022 mint: budgets are discovered per owner (getTokenAccountsByOwner) and by registration', { tokenProgram: this.options.tokenProgram });
        this.warnedToken2022 = true;
      }
      entries = [];
      const owners = new Set<string>([...this.repos.budgets.openOwners(), ...this.repos.workspaces.list(1000).map((w) => w.owner)]);
      for (const owner of owners) entries.push(...(await this.reader.getParsedTokenAccountsByOwner(owner, this.options.mint)));
    }
    let n = 0;
    for (const entry of entries) {
      const state = parseTokenAccount(entry.pubkey, entry.account);
      if (state === undefined || state.mint !== this.options.mint || state.delegate !== operator) continue;
      this.applyState(state);
      n++;
    }
    return n;
  }

  /** Re-reads every open budget and recomputes its headroom; returns the number refreshed. */
  async refresh(): Promise<number> {
    const open = this.repos.budgets.listOpen();
    if (open.length === 0) return 0;
    const size = Math.min(100, this.options.batchSize ?? 100);
    let n = 0;
    for (let i = 0; i < open.length; i += size) {
      const chunk = open.slice(i, i + size);
      let accounts: Awaited<ReturnType<ChainReader['getMultipleParsedAccounts']>>;
      try {
        accounts = await this.reader.getMultipleParsedAccounts(chunk.map((b) => b.tokenAccount));
      } catch (e) {
        this.logger.warn('budget refresh failed', { tokenAccounts: chunk.map((b) => b.tokenAccount), error: e });
        continue;
      }
      chunk.forEach((budget, j) => {
        const account = accounts[j] ?? null;
        if (account === null) {
          this.markMissing(budget.tokenAccount);
          n++;
          return;
        }
        const state = parseTokenAccount(budget.tokenAccount, account);
        if (state === undefined) {
          this.logger.warn('budget account is no longer a token account', { tokenAccount: budget.tokenAccount });
          this.markMissing(budget.tokenAccount);
          n++;
          return;
        }
        this.applyState(state);
        n++;
      });
    }
    return n;
  }

  /**
   * Reads a token account for registration and checks that it holds the mint and is delegated to
   * the operator. Throws {@link BudgetRegisterError} otherwise.
   */
  async inspect(tokenAccount: string): Promise<TokenAccountState> {
    const [account] = await this.reader.getMultipleParsedAccounts([tokenAccount]);
    if (account === null || account === undefined) throw new BudgetRegisterError('not_found', `token account ${tokenAccount} does not exist on this cluster`);
    const state = parseTokenAccount(tokenAccount, account);
    if (state === undefined) throw new BudgetRegisterError('not_token_account', `${tokenAccount} is not an SPL token account`);
    if (state.mint !== this.options.mint) throw new BudgetRegisterError('wrong_mint', `${tokenAccount} holds ${state.mint}, not the BEAGLE mint ${this.options.mint}`);
    if (this.options.operator === undefined || state.delegate !== this.options.operator) {
      throw new BudgetRegisterError(
        'not_delegated',
        this.options.operator === undefined
          ? 'this gateway has no operator configured; budgets are disabled'
          : `${tokenAccount} is not delegated to the operator ${this.options.operator} (delegate: ${state.delegate ?? 'none'}); run ApproveChecked first`,
      );
    }
    return state;
  }

  /**
   * `POST /api/budgets/register`: {@link inspect} then insert the budget (funding `workspace`,
   * default the owner / the existing row's workspace) and return the row.
   */
  async register(tokenAccount: string, workspace?: string): Promise<BudgetRow> {
    const state = await this.inspect(tokenAccount);
    return this.applyState(state, undefined, { registeredAt: this.now(), ...(workspace === undefined ? {} : { workspace }) });
  }
}
