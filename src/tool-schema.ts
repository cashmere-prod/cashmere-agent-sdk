import { z } from 'zod';
import { ALL_NETWORKS } from './constants';

const networkEnum = ALL_NETWORKS as [string, ...string[]];

export const bridgeZodSchema = z.object({
  from: z.enum(networkEnum).describe('Source chain'),
  to: z.enum(networkEnum).describe('Destination chain'),
  amount: z.string().describe('USDC amount in human-readable form (e.g. "100")'),
  recipient: z.string().describe('Destination wallet address'),
  version: z.enum(['v1', 'v2-fast', 'v2-norm']).optional().describe('CCTP version (auto-resolved if omitted)'),
  feeMode: z.enum(['native', 'stable']).optional().describe('Fee payment mode (default: native)'),
});

export const simulateZodSchema = z.object({
  from: z.enum(networkEnum).describe('Source chain'),
  to: z.enum(networkEnum).describe('Destination chain'),
  amount: z.string().describe('USDC amount in human-readable form (e.g. "100")'),
  version: z.enum(['v1', 'v2-fast', 'v2-norm']).optional().describe('CCTP version (auto-resolved if omitted)'),
  feeMode: z.enum(['native', 'stable']).optional().describe('Fee payment mode (default: native)'),
});

export const bridgeToolSchema = {
  name: 'cashmere_bridge',
  description: 'Bridge USDC across chains via Cashmere CCTP. Supports 16 chains including EVM (Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, Linea, Worldchain, Sei, Sonic, HyperEVM, Monad, Unichain), Solana, Aptos, and Sui. Destination mint is handled automatically by Cashmere relayers.',
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
