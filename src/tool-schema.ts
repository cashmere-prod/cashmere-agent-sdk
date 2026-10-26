import { z } from 'zod';
import { ALL_NETWORKS } from './constants';
import type { Network } from './types';

const networkEnum = ALL_NETWORKS as [Network, ...Network[]];

// USDC has 6 decimals
const amountZod = z.string()
  .regex(/^\d+(\.\d{1,6})?$/, 'USDC amount as a plain decimal with up to 6 decimals, e.g. "100" or "0.5"')
  .describe('USDC amount in human-readable form (e.g. "100")');

export const bridgeZodSchema = z.object({
  from: z.enum(networkEnum).describe('Source chain'),
  to: z.enum(networkEnum).describe('Destination chain'),
  amount: amountZod,
  recipient: z.string().describe('Destination wallet address'),
  version: z.enum(['v1', 'v2-fast', 'v2-norm']).optional().describe('CCTP version (auto-resolved if omitted)'),
  feeMode: z.enum(['native', 'stable']).optional().describe('Fee payment mode (default: native)'),
});

export const simulateZodSchema = z.object({
  from: z.enum(networkEnum).describe('Source chain'),
  to: z.enum(networkEnum).describe('Destination chain'),
  amount: amountZod,
  version: z.enum(['v1', 'v2-fast', 'v2-norm']).optional().describe('CCTP version (auto-resolved if omitted)'),
  feeMode: z.enum(['native', 'stable']).optional().describe('Fee payment mode (default: native)'),
});

export const supportedRoutesZodSchema = z.object({
  from: z.enum(networkEnum).optional().describe('Only routes from this chain'),
  to: z.enum(networkEnum).optional().describe('Only routes to this chain'),
});

export const bridgeToolSchema = {
  name: 'cashmere_bridge',
  description: 'Bridge USDC across chains via Cashmere CCTP. This sends a real transaction that spends USDC from the configured wallet and cannot be undone. Before every call, tell the user the amount, the source and destination chains and the recipient address (run cashmere_simulate first to include the fee and duration), and call it only once the user has confirmed those exact values. Never guess or fill in a recipient yourself. If a call fails, do not retry on your own: the transaction may already be on chain, so report the error and let the user decide. Supports 16 chains including EVM (Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, Linea, Worldchain, Sei, Sonic, HyperEVM, Monad, Unichain), Solana, Aptos, and Sui. Destination mint is handled automatically by Cashmere relayers.',
  parameters: {
    type: 'object' as const,
    properties: {
      from: { type: 'string', enum: ALL_NETWORKS, description: 'Source chain' },
      to: { type: 'string', enum: ALL_NETWORKS, description: 'Destination chain' },
      amount: { type: 'string', description: 'USDC amount in human-readable form (e.g. "100")' },
      recipient: { type: 'string', description: 'Destination wallet address' },
      version: { type: 'string', enum: ['v1', 'v2-fast', 'v2-norm'], description: 'CCTP version (auto-resolved if omitted)' },
      feeMode: { type: 'string', enum: ['native', 'stable'], description: 'Fee payment mode (default: native)' },
    },
    required: ['from', 'to', 'amount', 'recipient'],
  },
};

export const simulateToolSchema = {
  name: 'cashmere_simulate',
  description: 'Simulate a USDC bridge transfer without executing. Returns estimated fee, duration, supported CCTP version, and route viability. Use this before cashmere_bridge to preview costs.',
  parameters: {
    type: 'object' as const,
    properties: {
      from: { type: 'string', enum: ALL_NETWORKS, description: 'Source chain' },
      to: { type: 'string', enum: ALL_NETWORKS, description: 'Destination chain' },
      amount: { type: 'string', description: 'USDC amount in human-readable form (e.g. "100")' },
      version: { type: 'string', enum: ['v1', 'v2-fast', 'v2-norm'], description: 'CCTP version (auto-resolved if omitted)' },
      feeMode: { type: 'string', enum: ['native', 'stable'], description: 'Fee payment mode (default: native)' },
    },
    required: ['from', 'to', 'amount'],
  },
};

export const supportedRoutesToolSchema = {
  name: 'cashmere_supported_routes',
  description: 'List the routes Cashmere bridges USDC over: for each source chain, its destinations, the CCTP versions used, the version picked when none is requested, and the estimated duration. Read-only. Filter with from and/or to.',
  parameters: {
    type: 'object' as const,
    properties: {
      from: { type: 'string', enum: ALL_NETWORKS, description: 'Only routes from this chain' },
      to: { type: 'string', enum: ALL_NETWORKS, description: 'Only routes to this chain' },
    },
    required: [] as string[],
  },
};
