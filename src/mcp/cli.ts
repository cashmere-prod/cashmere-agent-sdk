#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  SECRET_ENV_NAMES, bridgeEnabled, createCashmereMcpServer, redact, serverOptionsFromEnv, signerChains,
  type CashmereMcpServerOptions,
} from './server';

// stdout carries the MCP messages, so anything a dependency prints goes to stderr instead
console.log = console.info = console.debug = console.error;

let options: CashmereMcpServerOptions;
try {
  options = serverOptionsFromEnv();
} catch (err) {
  console.error(`cashmere-mcp: ${(err as Error).message}`);
  process.exit(1);
}
// Read once; nothing else in the process needs them
for (const name of SECRET_ENV_NAMES) delete process.env[name];

function status(): string {
  if (bridgeEnabled(options)) {
    const cap = options.maxAmount === undefined ? '' : `, at most ${options.maxAmount} USDC per transfer`;
    const total = options.maxTotal === undefined ? '' : `, ${options.maxTotal} USDC in total`;
    const allow = options.allowedRecipients === undefined ? '' : `, ${options.allowedRecipients.length} allowed recipients`;
    return `cashmere_bridge signs for ${signerChains(options.config).join(', ')}${cap}${total}${allow}`;
  }
  if (options.readOnly) return 'read-only (CASHMERE_MCP_READ_ONLY), cashmere_bridge is off';
  return 'no private key set, cashmere_bridge is off';
}

createCashmereMcpServer(options)
  .connect(new StdioServerTransport())
  .then(() => console.error(`cashmere-mcp: running on stdio, ${status()}`))
  .catch(err => {
    console.error(`cashmere-mcp: ${redact(err instanceof Error ? err.message : String(err), options.config)}`);
    process.exit(1);
  });
