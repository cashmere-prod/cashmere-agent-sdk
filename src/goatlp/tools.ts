// Registration of the Goat LP tools on the Cashmere MCP server. The read tools are always on; the write tools are added by
// the server only when an EVM key is configured and the server is not read-only.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GoatLpContext } from './context';
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
