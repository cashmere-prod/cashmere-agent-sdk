import { readFileSync } from 'fs';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseUnits } from 'viem';
import { CashmereCCTP } from '../index';
import type { CashmereCCTPConfig, Network } from '../types';
import { EVM_NETWORKS } from '../constants';
import {
  bridgeToolSchema, bridgeZodSchema,
  simulateToolSchema, simulateZodSchema,
  supportedRoutesToolSchema, supportedRoutesZodSchema,
} from '../tool-schema';
import { getSupportedRoutes } from '../utils/supported-routes';
import { recipientError } from '../utils/address';

export interface CashmereMcpServerOptions {
  config: CashmereCCTPConfig;
  // Leaves cashmere_bridge out: the server quotes transfers but never sends one
  readOnly?: boolean;
  // Largest USDC amount cashmere_bridge sends in one transfer
  maxAmount?: string;
  // Defaults to a CashmereCCTP built from `config`
  cctp?: Pick<CashmereCCTP, 'simulate' | 'transfer'>;
}

const SIGNERS = ['evm', 'solana', 'aptos', 'sui'] as const;
const ENV_PREFIX = { evm: 'EVM', solana: 'SOLANA', aptos: 'APTOS', sui: 'SUI' } as const;
const OFF = ['', '0', 'false', 'no', 'off'];
const USDC_AMOUNT = /^\d+(\.\d{1,6})?$/;

// src/mcp and dist/mcp both sit two levels below package.json
const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };

const INSTRUCTIONS = 'Cashmere moves USDC between 16 chains (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, '
  + 'Unichain, Linea, Worldchain, Sei, Sonic, HyperEVM, Monad, Solana, Aptos, Sui) over Circle CCTP: cross-chain '
  + 'USDC payments, transfers and treasury moves. cashmere_supported_routes lists routes, CCTP versions and durations, '
  + 'and cashmere_simulate quotes the fee and duration of a transfer; both are read-only.';

export function signerChains(config: CashmereCCTPConfig): string[] {
  return SIGNERS.filter(chain => config[chain]);
}

export function bridgeEnabled({ config, readOnly }: CashmereMcpServerOptions): boolean {
  return !readOnly && signerChains(config).length > 0;
}

// The MCP server takes its keys from the environment only, as the MCP client config passes them
export function serverOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): CashmereMcpServerOptions {
  const read = (name: string) => {
    const value = env[name]?.trim();
    // A ${...} left as is means the client config had nothing to substitute
    return value && !/^\$\{[^}]*\}$/.test(value) ? value : undefined;
  };
  const readOnly = !OFF.includes((read('CASHMERE_MCP_READ_ONLY') ?? '').toLowerCase());
  const maxAmount = read('CASHMERE_MCP_MAX_AMOUNT');
  if (maxAmount !== undefined && !USDC_AMOUNT.test(maxAmount)) {
    throw new Error(`CASHMERE_MCP_MAX_AMOUNT is "${maxAmount}": set a USDC amount such as "500" or "0.5"`);
  }
  const config: CashmereCCTPConfig = { gasApiUrl: read('GAS_API_URL') };

  // A read-only server does not even read the keys
  if (!readOnly) {
    for (const chain of SIGNERS) {
      const privateKey = read(`${ENV_PREFIX[chain]}_PRIVATE_KEY`);
      if (privateKey) config[chain] = { privateKey, rpcUrl: read(`${ENV_PREFIX[chain]}_RPC_URL`) };
    }
  }
  return { config, readOnly, maxAmount };
}

// Every configured private key in the spellings a library might echo back, longest first
function secretPatterns(config: CashmereCCTPConfig): RegExp[] {
  const secrets = new Set<string>();
  for (const chain of SIGNERS) {
    const key = config[chain]?.privateKey;
    if (!key) continue;
    const bare = key.startsWith('0x') ? key.slice(2) : key;
    secrets.add(key).add(bare).add(`0x${bare}`);
    // Aptos CLI keys append the public key to the 32-byte private key, which is all the signer uses
    if (/^[0-9a-f]{128}$/i.test(bare)) secrets.add(bare.slice(0, 64));
  }
  return [...secrets]
    .filter(secret => secret.length >= 16)
    .sort((a, b) => b.length - a.length)
    .map(secret => new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
}

export function redact(text: string, config: CashmereCCTPConfig): string {
  return secretPatterns(config).reduce((out, pattern) => out.replace(pattern, '[redacted]'), text);
}

function sources(config: CashmereCCTPConfig): Network[] {
  return [
    ...(config.evm ? EVM_NETWORKS : []),
    ...(['solana', 'aptos', 'sui'] as const).filter(chain => config[chain]),
  ];
}

// Why cashmere_bridge must not send these values, or undefined when it may
export function bridgeCheck(
  params: { to: Network; amount: string; recipient: string },
  maxAmount?: string,
): string | undefined {
  const recipient = recipientError(params.to, params.recipient);
  if (recipient) return `Not sent: ${recipient}.`;
  if (maxAmount !== undefined && parseUnits(params.amount, 6) > parseUnits(maxAmount, 6)) {
    return `Not sent: ${params.amount} USDC is above this server's limit of ${maxAmount} USDC per transfer (CASHMERE_MCP_MAX_AMOUNT).`;
  }
  return undefined;
}

export function createCashmereMcpServer(options: CashmereMcpServerOptions): McpServer {
  const { config, readOnly, maxAmount } = options;
  const cctp = options.cctp ?? new CashmereCCTP(config);
  const bridge = bridgeEnabled(options);

  const server = new McpServer({ name: 'cashmere', version }, {
    instructions: bridge
      ? `${INSTRUCTIONS} cashmere_bridge sends a real transfer from the configured wallet: run cashmere_simulate first, `
        + 'show the user the amount, source chain, destination chain and recipient, and call it only after the user '
        + 'confirms them. Never retry a failed transfer without asking the user.'
      : `${INSTRUCTIONS} This server cannot send transfers: cashmere_bridge is off because `
        + (readOnly ? 'CASHMERE_MCP_READ_ONLY is set.' : 'no signer private key is configured.'),
  });

  const run = async (call: () => unknown): Promise<CallToolResult> => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await call()) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: redact(message, config) }], isError: true };
    }
  };

  server.registerTool('cashmere_supported_routes', {
    title: 'Cashmere supported routes',
    description: supportedRoutesToolSchema.description,
    inputSchema: supportedRoutesZodSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ from, to }) => run(() => ({ routes: getSupportedRoutes({ from, to }) })));

  server.registerTool('cashmere_simulate', {
    title: 'Simulate a Cashmere transfer',
    description: simulateToolSchema.description,
    inputSchema: simulateZodSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, params => run(() => cctp.simulate(params)));

  if (bridge) {
    // One transfer at a time: parallel calls from one wallet would race for its nonce
    let queue: Promise<unknown> = Promise.resolve();

    server.registerTool('cashmere_bridge', {
      title: 'Bridge USDC with Cashmere',
      description: `${bridgeToolSchema.description} This server can send from: ${sources(config).join(', ')}.`
        + (maxAmount === undefined ? '' : ` It sends at most ${maxAmount} USDC per transfer.`),
      inputSchema: bridgeZodSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      // Claude Code then shows its full permission prompt instead of a one-tap approval
      _meta: { 'anthropic/requiresUserInteraction': true },
    }, params => {
      const result = queue.then(() => run(() => {
        const problem = bridgeCheck(params, maxAmount);
        if (problem) throw new Error(problem);
        return cctp.transfer(params);
      }));
      queue = result;
      return result;
    });
  }

  return server;
}
