// Registration of the Goat LP tools on the Cashmere MCP server. The read tools are always on; the write tools are added by
// the server only when an EVM key is configured and the server is not read-only.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { planSetAutomation, planStop, type SetAutomationInput } from './automation';
import { DEPOSIT_SLIPPAGE_MAX_BPS, DEPOSIT_SLIPPAGE_MIN_BPS } from './constants';
import type { GoatLpContext } from './context';
import { planAddLiquidity, type AddLiquidityInput, type DepositLedger } from './deposit';
import { PlanStore, executeSteps, fingerprintOf, inputKeyOf, planSimulation, type BuiltPlan, type PlanBasis } from './plans';
import { poolTool, poolsTool, positionTool, positionsTool } from './read';

export const GOATLP_READ_TOOLS = ['goatlp_pools', 'goatlp_pool', 'goatlp_positions', 'goatlp_position'] as const;

export const GOATLP_WARNING = 'Goat LP is experimental. Use small amounts.';

/** JSON text of a result; bigint values become decimal strings */
export const toJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** The server's error handling: the message only, with the configured secrets removed */
export type Redactor = (text: string) => string;

export function goatRun(redact: Redactor) {
  return async (call: () => unknown): Promise<CallToolResult> => {
    try {
      // a result can quote a chain error (a note, not a failure), which may name the RPC URL: redacted as well
      return { content: [{ type: 'text', text: redact(toJson(await call())) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: redact(message) }], isError: true };
    }
  };
}

const venue = z.enum(['v3', 'v4']).describe('Uniswap venue: v3 or v4');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, '0x followed by 40 hex characters');
const positionId = z.union([z.string().regex(/^\d{1,20}$/, 'a whole number'), z.number().int().nonnegative()])
  .transform((x) => String(x)).describe('The position NFT id');

export function registerGoatLpReadTools(server: McpServer, ctx: GoatLpContext, redact: Redactor): void {
  const run = goatRun(redact);
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool('goatlp_pools', {
    title: 'Goat LP pools',
    description: 'List Goat LP liquidity pools on Robinhood Chain (Uniswap v3 and v4) with APR, fee APR, rewards APR, TVL, 24 h volume and fees, '
      + 'fee tier and venue, and whether Goat LP auto-compound, auto-range and auto-exit are offered on each pool (checked on chain). '
      + 'Filter by token (symbol or address), venue or minimum TVL; sort by apr, tvl or volume; 20 pools by default, at most 50. Read-only.',
    inputSchema: {
      token: z.string().min(1).max(64).optional().describe('Token symbol (such as USDG) or token address; only pools with this token'),
      venue: venue.optional(),
      minTvlUsd: z.number().nonnegative().optional().describe('Only pools with at least this TVL in USD'),
      sortBy: z.enum(['apr', 'tvl', 'volume']).optional().describe('Sort key, highest first (default tvl)'),
      limit: z.number().int().min(1).max(50).optional().describe('How many pools (default 20)'),
      automation: z.boolean().optional().describe('Check on chain which automations each pool offers (default true)'),
    },
    annotations: ro,
  }, (input) => run(() => poolsTool(ctx, input)));

  server.registerTool('goatlp_pool', {
    title: 'Goat LP pool detail',
    description: "One Goat LP pool on Robinhood Chain: price (both directions), tick, TVL, the last 24 h volume, fees and APR breakdown, "
      + 'its hook and whether that hook is reviewed, suggested price ranges (±1%, ±5%, ±10%, ±20%, full) with their ticks, and which of '
      + 'auto-compound, auto-range and auto-exit it supports, with the reason when one is not offered and the limits of the pair. Read-only.',
    inputSchema: {
      venue,
      pool: z.string().describe('v3: the pool address; v4: the 32-byte pool id'),
    },
    annotations: ro,
  }, (input) => run(() => poolTool(ctx, input)));

  server.registerTool('goatlp_positions', {
    title: 'Goat LP positions of an owner',
    description: 'The Uniswap v3 and v4 liquidity positions of an owner on Robinhood Chain (default: this server\'s wallet): pair, in-range state, '
      + 'value, uncollected fees, APR and PnL as api.cashmere.exchange gives them, and whether auto-compound, auto-range and auto-exit are on '
      + '(read on chain) with the keeper\'s status. Open positions by default; 20 per page, at most 50; pass nextCursor for the next page. Read-only.',
    inputSchema: {
      owner: address.optional().describe('Owner address (default: the configured wallet)'),
      venue: venue.optional(),
      includeClosed: z.boolean().optional().describe('Also list closed positions'),
      limit: z.number().int().min(1).max(50).optional().describe('How many positions (default 20)'),
      cursor: z.string().max(200).optional().describe('nextCursor of the previous page'),
    },
    annotations: ro,
  }, (input) => run(() => positionsTool(ctx, input)));

  server.registerTool('goatlp_position', {
    title: 'Goat LP position detail',
    description: 'One Uniswap v3 or v4 position on Robinhood Chain: amounts, value, uncollected fees, APR and PnL, its cash flows, the permission '
      + 'set on the position NFT, every automation rule read on chain (auto-compound, auto-range, auto-exit settings, moves left, signed '
      + 'messages left), the keeper\'s status, and which automations could be turned on and why not. Read-only.',
    inputSchema: { venue, id: positionId },
    annotations: ro,
  }, (input) => run(() => positionTool(ctx, input)));
}

// ------------------------------------------------------------------ write tools

export const GOATLP_WRITE_TOOLS = ['goatlp_add_liquidity', 'goatlp_set_auto_range', 'goatlp_set_auto_exit', 'goatlp_set_auto_compound', 'goatlp_stop_automation'] as const;

const TWO_STEP = 'Two steps: without execute it returns a plan (every transaction and signature in order, with contracts, addresses, '
  + 'settings, fees and the simulation result) and a planId, and sends nothing. Show the plan to the user; only after the user confirms it, '
  + 'call again with the same inputs plus execute: true and that planId (single use, valid 10 minutes). Never execute a plan the user has not seen.';

const writeMeta = {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // Claude Code then shows its full permission prompt instead of a one-tap approval
  _meta: { 'anthropic/requiresUserInteraction': true },
} as const;

const planFields = {
  execute: z.boolean().optional().describe('Send the plan. Only with the planId of a plan the user has seen and confirmed'),
  planId: z.string().regex(/^[0-9a-f]{24}$/, 'the planId a plan returned').optional().describe('The planId of the confirmed plan (with execute: true)'),
};
const bps = (min: number, max: number, what: string) => z.number().int().min(min).max(max).describe(what);

/** The server's single write queue: one transaction flow at a time from the wallet */
export type Serial = (work: () => Promise<CallToolResult>) => Promise<CallToolResult>;

export function registerGoatLpWriteTools(server: McpServer, ctx: GoatLpContext, redact: Redactor, serial: Serial): void {
  const run = goatRun(redact);
  const store = new PlanStore(ctx.now);

  const flow = <I extends { execute?: boolean; planId?: string }>(tool: string, build: (input: I, basis: PlanBasis) => Promise<BuiltPlan>) =>
    (input: I, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      const signer = ctx.signer;
      if (!input.execute) {
        return run(async () => {
          if (!signer) throw new Error('Not planned: this server has no wallet configured.');
          const wiring = await ctx.wiring();
          if (wiring) throw new Error(`Not planned: ${wiring}`);
          const nowSec = ctx.nowSec();
          const plan = await build(input, { nowSec });
          await planSimulation(ctx.chain, signer.address, plan.steps);
          const basis: PlanBasis = { ...plan.basis, nowSec };
          const rec = store.create(tool, inputKeyOf(input as Record<string, unknown>), basis, fingerprintOf(plan.steps, plan.fingerprintExtra));
          const expiresAt = store.expiresAt(rec);
          return {
            planId: rec.id, expiresAt, wallet: signer.address, ...plan.view,
            steps: plan.steps.map((s, i) => ({ step: i + 1, action: s.label, ...s.view })),
            warning: GOATLP_WARNING,
            next: plan.next ? `Nothing was sent. ${plan.next}`
              : `Nothing was sent. Show this plan to the user. Only after the user confirms it, call ${tool} again with the same inputs plus execute: true and planId "${rec.id}" (valid until ${expiresAt}).`,
          };
        });
      }
      return serial(() => run(async () => {
        if (extra.signal.aborted) throw new Error('Not sent: the request was cancelled before the plan started.');
        if (!signer) throw new Error('Not sent: this server has no wallet configured.');
        if (!input.planId) throw new Error('Not sent: execute: true needs the planId of the plan the user confirmed. Call without execute first.');
        const wiring = await ctx.wiring();
        if (wiring) throw new Error(`Not sent: ${wiring}`);
        const rec = store.take(input.planId, tool, inputKeyOf(input as Record<string, unknown>));
        const plan = await build(input, rec.basis);
        if (fingerprintOf(plan.steps, plan.fingerprintExtra) !== rec.fingerprint) {
          throw new Error('Not sent: the plan is no longer the same as the one shown (the chain changed since, such as a price, a permission or a signed-message slot). Call without execute for a new plan and show it to the user.');
        }
        const steps = await executeSteps(ctx.chain, signer, plan.steps, extra.signal);
        const now = plan.readBack ? await plan.readBack().catch(() => undefined) : undefined;
        return { executed: true, planId: rec.id, steps, ...(now ? { now } : {}) };
      }));
    };

  const venue = z.enum(['v3', 'v4']).describe('Uniswap venue of the position: v3 or v4');
  const id = positionId;

  server.registerTool('goatlp_set_auto_range', {
    title: 'Goat LP auto-range',
    description: 'Turn on (or change) Goat LP auto-range for one Uniswap v3 or v4 position the configured wallet owns on Robinhood Chain: '
      + "when the price leaves the range by the trigger distance, a keeper moves the position to a new range around the price. The fee is 0.15% "
      + 'of the amount moved, per move. Defaults are the app\'s: the closest trigger the pair allows, 0.5% price protection, on v4 at most one '
      + 'move every 6 hours and 20 moves per saved rule; on v3 each move makes a new position ID and the new width defaults to the current one. '
      + `Permission: this position only (v3: AutoRange; v4: GoatV4StewardEngine). One automation per position. ${TWO_STEP}`,
    inputSchema: {
      venue, id,
      triggerPct: z.number().positive().max(200).optional().describe('Move when the price is this many percent past the range (default: the closest the pair allows)'),
      triggerTicks: z.number().int().min(1).max(20_000).optional().describe('The trigger distance in ticks instead of triggerPct'),
      newWidthPctEachSide: z.number().positive().max(1000).optional().describe('v3 only: the new range, this many percent each side of the price (default: the current width)'),
      newWidthTicks: z.number().int().positive().optional().describe('v3 only: the new range width in ticks instead of newWidthPctEachSide'),
      maxPriceProtectionBps: bps(10, 100, 'Price protection of the swap inside a move, in bps (default 50 = 0.5%; the pair may allow less)').optional(),
      minIntervalHours: z.number().min(1).max(720).optional().describe('v4 only: at most one move every N hours (default 6)'),
      maxSwapFeePct: z.number().positive().max(10).optional().describe('v4 only: the highest pool fee the swap inside a move may pay, in percent (default 1)'),
      ...planFields,
    },
    ...writeMeta,
  }, flow('goatlp_set_auto_range', (i: SetToolInput, b) => planSetAutomation(ctx, { ...i, kind: 'range' }, b.nowSec)));

  const lowerIn = z.object({
    tick: z.number().int().optional().describe('The exit level as a tick'),
    pctBelowRange: z.number().positive().max(99).optional().describe('The exit level this many percent below the lower edge of the range (default 5)'),
    swap: z.boolean().optional().describe('Swap everything to token1 at the exit (default false: withdraw only)'),
  }).strict();
  const upperIn = z.object({
    tick: z.number().int().optional().describe('The exit level as a tick'),
    pctAboveRange: z.number().positive().max(10_000).optional().describe('The exit level this many percent above the upper edge of the range (default 5)'),
    swap: z.boolean().optional().describe('Swap everything to token0 at the exit (default false: withdraw only)'),
  }).strict();

  server.registerTool('goatlp_set_auto_exit', {
    title: 'Goat LP auto-exit',
    description: 'Turn on (or change) Goat LP auto-exit for one Uniswap v3 or v4 position the configured wallet owns on Robinhood Chain: when '
      + 'the price reaches a level below or above the range, a keeper closes the position and everything goes to the owner (withdraw only, '
      + 'or swap all to one token). Runs once, then turns itself off. The fee is 0.15%, once. Give at least one side; a side without a level '
      + 'defaults to 5% beyond the range edge. Permission: this position only (v3: AutoExit; v4: GoatV4StewardEngine). One automation per '
      + `position. ${TWO_STEP}`,
    inputSchema: {
      venue, id,
      lower: lowerIn.optional().describe('Exit when the price falls to this level (below the range)'),
      upper: upperIn.optional().describe('Exit when the price rises to this level (above the range)'),
      maxPriceProtectionBps: bps(10, 100, 'Price protection of a swap exit, in bps (default 50 = 0.5%; the pair may allow less)').optional(),
      maxSwapFeePct: z.number().positive().max(10).optional().describe('v4 only: the highest pool fee a swap exit may pay, in percent (default 1)'),
      ...planFields,
    },
    ...writeMeta,
  }, flow('goatlp_set_auto_exit', (i: ExitToolInput, b) => planSetAutomation(ctx, {
    ...i, kind: 'exit',
    lower: i.lower ? { tick: i.lower.tick, pctBeyondRange: i.lower.pctBelowRange, swap: i.lower.swap } : undefined,
    upper: i.upper ? { tick: i.upper.tick, pctBeyondRange: i.upper.pctAboveRange, swap: i.upper.swap } : undefined,
  }, b.nowSec)));

  server.registerTool('goatlp_set_auto_compound', {
    title: 'Goat LP auto-compound',
    description: 'Turn on (or change) Goat LP auto-compound for one Uniswap v3 or v4 position the configured wallet owns on Robinhood Chain: a '
      + 'keeper collects the fees and adds them back to the position (or, on v4, sends them to the wallet). Goat LP takes 10% of the fees; '
      + 'Cashmere pays the gas. v3: one permission for this position to GoatAutoCompoundV3. v4: no permission on the NFT; the wallet signs one '
      + 'message per run (free, at most 30 per batch, valid at most 90 days; defaults 12 runs for 30 days, or 4 for 90 days under the minimum '
      + 'size), and the signed messages are handed to the keeper store at api.cashmere.exchange. signMore: true signs another batch for a rule '
      + `that is on. One automation per position. ${TWO_STEP}`,
    inputSchema: {
      venue, id,
      maxPriceProtectionBps: bps(1, 2000, 'Price protection of the swap inside a compound, in bps (default 100 = 1%; v3 at most 500)').optional(),
      minIntervalHours: z.number().min(1).max(720).optional().describe('At most one compound every N hours (default: 1 on v3; on v4 the signing period over the runs)'),
      swapToMatch: z.boolean().optional().describe('v3 only: swap part of the fees so they fit the range (default true)'),
      mode: z.enum(['addBack', 'claim']).optional().describe('v4 only: addBack puts the fees back in the position (default); claim sends them to the wallet'),
      runsToSign: z.number().int().min(1).max(30).optional().describe('v4 only: how many runs to sign now (default 12, or 4 for a small position)'),
      horizonDays: z.number().int().min(1).max(90).optional().describe('v4 only: how many days the signed runs last (default 30, or 90 for a small position)'),
      signMore: z.boolean().optional().describe('v4 only: sign and hand over another batch for the rule that is on, without changing it'),
      ...planFields,
    },
    ...writeMeta,
  }, flow('goatlp_set_auto_compound', (i: SetToolInput, b) => planSetAutomation(ctx, { ...i, kind: 'compound' }, b.nowSec)));

  server.registerTool('goatlp_stop_automation', {
    title: 'Stop a Goat LP automation',
    description: 'Stop auto-compound, auto-range or auto-exit on one position the configured wallet owns on Robinhood Chain, as the app does: '
      + 'v3: the rule off, then this automation\'s permission removed; v4 auto-range / auto-exit: the rule cleared, then its permission removed; '
      + 'v4 auto-compound: the rule off, then every signed and unused message cancelled on chain and any permission removed, then the keeper '
      + `store asked to drop the messages. Another app's approval is never touched. The position itself stays as it is. ${TWO_STEP}`,
    inputSchema: { venue, id, kind: z.enum(['compound', 'range', 'exit']).describe('The automation to stop'), ...planFields },
    ...writeMeta,
  }, flow<StopToolInput>('goatlp_stop_automation', (i) => planStop(ctx, i)));

  // USD the deposits sent, or may have sent, while the server runs (CASHMERE_GOATLP_MAX_TOTAL_USD)
  const ledger: DepositLedger = { totalUsd: 0 };
  const { maxDepositUsd, maxTotalUsd } = ctx.settings;
  const limits = (maxDepositUsd === undefined ? '' : ` It deposits at most ${maxDepositUsd} USD per call.`)
    + (maxTotalUsd === undefined ? '' : ` It deposits at most ${maxTotalUsd} USD in total while it runs.`);
  const amount = z.string().max(80).regex(/^\d+(\.\d+)?$/, 'a plain decimal number such as 1.5');

  server.registerTool('goatlp_add_liquidity', {
    title: 'Goat LP add liquidity',
    description: 'Add liquidity on Robinhood Chain from the configured wallet, with no swap: open a new Uniswap v3 or v4 position (pool and '
      + 'range) or add to a position the wallet owns (id). Amounts are in token units: amount0 for the pool\'s token0 and amount1 for token1, '
      + 'as goatlp_pool lists them; leave one out to match the other at the pool price. What the range does not need stays in the wallet. '
      + 'The range of a new position: tickLower and tickUpper, rangePct (percent below and above the price), or fullRange. v3: each token is '
      + 'approved to the position manager for exactly this deposit; payWithEth pays the WETH side with ETH (unused ETH comes back). v4: pools '
      + 'without a hook only; tokens go through Permit2 with an exact allowance that lasts 30 minutes; native ETH goes with the call and unused '
      + 'ETH comes back. Refused: a token that copies an official stock ticker, a token that takes a fee when it moves, and a pool price more '
      + 'than 5% away from Chainlink. When the pool price is more than 1% from Chainlink, the plan lists acknowledge lines: execute refuses '
      + 'that plan; show the lines to the user, and after a yes plan again with acknowledge: true and execute the new plan.'
      + `${limits} ${TWO_STEP}`,
    inputSchema: {
      venue,
      id: positionId.optional().describe('Add to this position (the configured wallet must own it)'),
      pool: z.string().max(80).optional().describe('Open a new position in this pool: v3 the pool address, v4 the 32-byte pool id'),
      tickLower: z.number().int().optional().describe('New position: the lower tick (a multiple of the pool\'s tick spacing)'),
      tickUpper: z.number().int().optional().describe('New position: the upper tick (a multiple of the pool\'s tick spacing)'),
      rangePct: z.number().positive().lt(100).optional().describe('New position: the range this many percent below and above the pool price'),
      fullRange: z.boolean().optional().describe('New position: the full price range'),
      amount0: amount.optional().describe('Amount of token0 in token units, such as 0.05'),
      amount1: amount.optional().describe('Amount of token1 in token units, such as 100'),
      slippageBps: z.number().int().min(DEPOSIT_SLIPPAGE_MIN_BPS).max(DEPOSIT_SLIPPAGE_MAX_BPS).optional()
        .describe('v3 only: the price move the minimums allow, in bps (default 100 = 1%, at most 300)'),
      payWithEth: z.boolean().optional().describe('v3 only: pay the WETH side with ETH'),
      acknowledge: z.boolean().optional().describe('The user agreed to the acknowledge lines of the plan; plan again with it, then execute that plan'),
      ...planFields,
    },
    ...writeMeta,
  }, flow<AddToolInput>('goatlp_add_liquidity', (i, b) => planAddLiquidity(ctx, i, b, ledger)));
}

type AddToolInput = AddLiquidityInput & { execute?: boolean; planId?: string };

type SetToolInput = Omit<SetAutomationInput, 'kind'> & { execute?: boolean; planId?: string };
type StopToolInput = { venue: 'v3' | 'v4'; id: string; kind: 'compound' | 'range' | 'exit'; execute?: boolean; planId?: string };
type ExitToolInput = Omit<SetAutomationInput, 'kind' | 'lower' | 'upper'> & {
  lower?: { tick?: number; pctBelowRange?: number; swap?: boolean };
  upper?: { tick?: number; pctAboveRange?: number; swap?: boolean };
  execute?: boolean; planId?: string;
};
