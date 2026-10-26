import { readFileSync } from 'fs';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatUnits, parseUnits } from 'viem';
import { z } from 'zod';
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
  // Largest USDC total cashmere_bridge sends while the server runs
  maxTotal?: string;
  // When set, the only recipients cashmere_bridge sends to
  allowedRecipients?: string[];
  // Defaults to a CashmereCCTP built from `config`
  cctp?: Pick<CashmereCCTP, 'simulate' | 'transfer'>;
  // Milliseconds since the epoch; tests move it
  now?: () => number;
}

const SIGNERS = ['evm', 'solana', 'aptos', 'sui'] as const;
// Prefixed: Claude Code passes the user's shell environment to MCP servers, and a key exported there for other tools
// must not turn into a wallet the agent can spend from
const ENV_PREFIX = { evm: 'CASHMERE_EVM', solana: 'CASHMERE_SOLANA', aptos: 'CASHMERE_APTOS', sui: 'CASHMERE_SUI' } as const;
// Keys, and RPC URLs, which often carry an API key
export const SECRET_ENV_NAMES = SIGNERS.flatMap(chain => [`${ENV_PREFIX[chain]}_PRIVATE_KEY`, `${ENV_PREFIX[chain]}_RPC_URL`]);
const OFF = ['', '0', 'false', 'no', 'off'];
const USDC_AMOUNT = /^\d+(\.\d{1,6})?$/;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

// src/mcp and dist/mcp both sit two levels below package.json
const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };

const INSTRUCTIONS = 'Cashmere moves USDC between 17 chains (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, '
  + 'Unichain, Linea, Worldchain, Sei, Sonic, HyperEVM, Monad, Arc, Solana, Aptos, Sui) over Circle CCTP: cross-chain '
  + 'USDC payments, transfers and treasury moves. cashmere_supported_routes lists routes, CCTP versions and durations, '
  + 'and cashmere_simulate quotes the fee and duration of a transfer; both are read-only.';

export function signerChains(config: CashmereCCTPConfig): string[] {
  return SIGNERS.filter(chain => config[chain]);
}

export function bridgeEnabled({ config, readOnly }: CashmereMcpServerOptions): boolean {
  return !readOnly && signerChains(config).length > 0;
}

// Endpoints that sign or carry transactions are reached over TLS; plain http is for a local node or mock.
// The message leaves the value out: an RPC URL often carries an API key.
function checkedUrl(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`${name} must use https`);
  return value;
}

// The MCP server takes its keys from the environment only, as the MCP client config passes them
export function serverOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): CashmereMcpServerOptions {
  const read = (name: string) => {
    const value = env[name]?.trim();
    // A ${...} left as is means the client config had nothing to substitute
    return value && !/^\$\{[^}]*\}$/.test(value) ? value : undefined;
  };
  const amount = (name: string) => {
    const value = read(name);
    if (value !== undefined && !USDC_AMOUNT.test(value)) {
      throw new Error(`${name} is "${value}": set a USDC amount such as "500" or "0.5"`);
    }
    return value;
  };
  const readOnly = !OFF.includes((read('CASHMERE_MCP_READ_ONLY') ?? '').toLowerCase());
  const maxAmount = amount('CASHMERE_MCP_MAX_AMOUNT');
  const maxTotal = amount('CASHMERE_MCP_MAX_TOTAL');
  const allowedRecipients = read('CASHMERE_MCP_ALLOWED_RECIPIENTS')?.split(',').map(r => r.trim()).filter(Boolean);
  const config: CashmereCCTPConfig = { gasApiUrl: checkedUrl('CASHMERE_GAS_API_URL', read('CASHMERE_GAS_API_URL')) };

  // A read-only server does not even read the keys
  if (!readOnly) {
    for (const chain of SIGNERS) {
      const privateKey = read(`${ENV_PREFIX[chain]}_PRIVATE_KEY`);
      const rpcUrl = checkedUrl(`${ENV_PREFIX[chain]}_RPC_URL`, read(`${ENV_PREFIX[chain]}_RPC_URL`));
      if (privateKey) config[chain] = { privateKey, rpcUrl };
    }
  }
  return { config, readOnly, maxAmount, maxTotal, allowedRecipients };
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

const sameAddress = (a: string, b: string) => (a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b);

// Why cashmere_bridge must not send these values, or undefined when it may
export function bridgeCheck(
  params: { to: Network; amount: string; recipient: string },
  limits: Pick<CashmereMcpServerOptions, 'maxAmount' | 'allowedRecipients'> = {},
): string | undefined {
  const { maxAmount, allowedRecipients } = limits;
  const recipient = recipientError(params.to, params.recipient);
  if (recipient) return `Not sent: ${recipient}.`;
  if (allowedRecipients && !allowedRecipients.some(allowed => sameAddress(allowed, params.recipient))) {
    return `Not sent: ${params.recipient} is not one of this server's allowed recipients (CASHMERE_MCP_ALLOWED_RECIPIENTS).`;
  }
  if (maxAmount !== undefined && parseUnits(params.amount, 6) > parseUnits(maxAmount, 6)) {
    return `Not sent: ${params.amount} USDC is above this server's limit of ${maxAmount} USDC per transfer (CASHMERE_MCP_MAX_AMOUNT).`;
  }
  return undefined;
}

export function createCashmereMcpServer(options: CashmereMcpServerOptions): McpServer {
  const { config, readOnly, maxAmount, maxTotal, allowedRecipients } = options;
  const now = options.now ?? Date.now;
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
    // USDC that left, or may have left, the wallet while the server runs
    let spent = 0n;
    const maxTotalRaw = maxTotal === undefined ? undefined : parseUnits(maxTotal, 6);
    // The last outcome of each transfer, so that a call retried after a timeout doesn't send twice
    const recent = new Map<string, { at: number; outcome: string }>();

    server.registerTool('cashmere_bridge', {
      title: 'Bridge USDC with Cashmere',
      description: `${bridgeToolSchema.description} This server can send from: ${sources(config).join(', ')}.`
        + (maxAmount === undefined ? '' : ` It sends at most ${maxAmount} USDC per transfer.`)
        + (maxTotal === undefined ? '' : ` It sends at most ${maxTotal} USDC in total while it runs.`)
        + (allowedRecipients === undefined ? '' : ' It sends only to the recipients its configuration allows.')
        + ' It refuses a transfer identical to one from the last 10 minutes unless allowDuplicate is true.',
      inputSchema: {
        ...bridgeZodSchema.shape,
        allowDuplicate: z.boolean().optional()
          .describe('Send although an identical transfer went out in the last 10 minutes. Only after the user confirms they want it twice'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      // Claude Code then shows its full permission prompt instead of a one-tap approval
      _meta: { 'anthropic/requiresUserInteraction': true },
    }, ({ allowDuplicate, ...params }, extra) => {
      const result = queue.then(() => run(async () => {
        // A call the client cancelled or timed out while it waited in the queue never starts
        if (extra.signal.aborted) throw new Error('Not sent: the request was cancelled before the transfer started.');
        const problem = bridgeCheck(params, { maxAmount, allowedRecipients });
        if (problem) throw new Error(problem);

        const amount = parseUnits(params.amount, 6);
        if (maxTotalRaw !== undefined && spent + amount > maxTotalRaw) {
          throw new Error(`Not sent: this server has sent ${formatUnits(spent, 6)} USDC, and ${params.amount} more would pass its total limit of ${maxTotal} USDC (CASHMERE_MCP_MAX_TOTAL).`);
        }
        const key = [params.from, params.to, params.amount, params.recipient.toLowerCase()].join('|');
        const earlier = recent.get(key);
        if (earlier && !allowDuplicate && now() - earlier.at < DUPLICATE_WINDOW_MS) {
          throw new Error(`Not sent: an identical transfer ${earlier.outcome} ${Math.round((now() - earlier.at) / 1000)} s ago. If the user wants to send it again, confirm with them, then call again with allowDuplicate: true.`);
        }

        try {
          const sent = await cctp.transfer(params);
          recent.set(key, { at: now(), outcome: `was sent (${sent.txHash})` });
          spent += amount;
          return sent;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A refusal before signing moved nothing; anything later may have reached the chain
          if (!message.startsWith('Not sent:') && !message.startsWith('Invalid recipient:')) {
            recent.set(key, { at: now(), outcome: 'failed and may still be on chain' });
            spent += amount;
          }
          throw err;
        }
      }));
      queue = result;
      return result;
    });
  }

  return server;
}
