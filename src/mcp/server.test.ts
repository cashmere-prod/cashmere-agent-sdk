import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_NETWORKS } from '../constants';
import type { TransferParams, TransferResult } from '../types';
import { createCashmereMcpServer, redact, serverOptionsFromEnv, type CashmereMcpServerOptions } from './server';

// A throwaway key so the bridge tool registers: cashmere_bridge only ever runs against a stub
const KEY = `0x${'ab'.repeat(32)}`;
const SUI_RECIPIENT = `0x${'5a'.repeat(32)}`;

async function connect(options: CashmereMcpServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createCashmereMcpServer(options).connect(serverTransport);
  const client = new Client({ name: 'cashmere-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

// The server runs from source, as `npx cashmere-mcp` runs dist/mcp/cli.js. The client passes only the env given
// here (plus PATH and HOME), so keys in the developer's shell never reach it.
async function spawn(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(__dirname, 'cli.ts')],
    cwd: join(__dirname, '..', '..'),
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'cashmere-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function json(result: Awaited<ReturnType<Client['callTool']>>) {
  const [content] = result.content as { type: string; text: string }[];
  return JSON.parse(content.text);
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map(t => t.name).sort();
}

test('with a signer the server lists simulate, routes and a confirm-first bridge', async () => {
  const client = await connect({ config: { evm: { privateKey: KEY }, sui: { privateKey: KEY } } });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['cashmere_bridge', 'cashmere_simulate', 'cashmere_supported_routes']);

  for (const name of ['cashmere_simulate', 'cashmere_supported_routes']) {
    assert.equal(tools.find(t => t.name === name)!.annotations?.readOnlyHint, true, name);
  }

  const bridge = tools.find(t => t.name === 'cashmere_bridge')!;
  assert.equal(bridge.annotations?.readOnlyHint, false);
  assert.equal(bridge.annotations?.destructiveHint, true);
  assert.equal(bridge.annotations?.idempotentHint, false);
  assert.equal(bridge._meta?.['anthropic/requiresUserInteraction'], true);
  assert.match(bridge.description!, /tell the user the amount, the source and destination chains and the recipient/);
  assert.match(bridge.description!, /only once the user has confirmed/);
  assert.match(bridge.description!, /send from: ethereum, .*monad, arc, sui\. /);
  assert.deepEqual([...bridge.inputSchema.required!].sort(), ['amount', 'from', 'recipient', 'to']);
  assert.match(client.getInstructions()!, /call it only after the user confirms/);
  await client.close();
});

test('read-only mode, or no key at all, leaves cashmere_bridge out', async () => {
  for (const options of [{ config: { evm: { privateKey: KEY } }, readOnly: true }, { config: {} }]) {
    const client = await connect(options);
    assert.deepEqual(await toolNames(client), ['cashmere_simulate', 'cashmere_supported_routes']);
    assert.match(client.getInstructions()!, /cannot send transfers/);
    await client.close();
  }
});

test('keys come from the CASHMERE_ environment variables, and CASHMERE_MCP_READ_ONLY keeps them unread', () => {
  assert.deepEqual(serverOptionsFromEnv({}), { config: { gasApiUrl: undefined }, readOnly: false, maxAmount: undefined, maxTotal: undefined, allowedRecipients: undefined });

  const { config } = serverOptionsFromEnv({
    CASHMERE_EVM_PRIVATE_KEY: ` ${KEY} `,
    CASHMERE_EVM_RPC_URL: 'https://rpc.example',
    CASHMERE_SOLANA_PRIVATE_KEY: '',
    // what a client passes when its config had nothing to substitute
    CASHMERE_SUI_PRIVATE_KEY: '${user_config.sui_private_key}',
    CASHMERE_GAS_API_URL: 'https://gas.example',
  });
  assert.deepEqual(config, { gasApiUrl: 'https://gas.example', evm: { privateKey: KEY, rpcUrl: 'https://rpc.example' } });

  // Claude Code passes the shell environment along: a key exported there for other tools is not a wallet for the agent
  assert.deepEqual(serverOptionsFromEnv({ EVM_PRIVATE_KEY: KEY, SOLANA_PRIVATE_KEY: KEY, GAS_API_URL: 'http://gas.example' }), { config: { gasApiUrl: undefined }, readOnly: false, maxAmount: undefined, maxTotal: undefined, allowedRecipients: undefined });

  for (const flag of ['1', 'true', 'YES', 'on']) {
    assert.deepEqual(serverOptionsFromEnv({ CASHMERE_EVM_PRIVATE_KEY: KEY, CASHMERE_MCP_READ_ONLY: flag }), {
      ...{ config: { gasApiUrl: undefined }, readOnly: false, maxAmount: undefined, maxTotal: undefined, allowedRecipients: undefined },
      readOnly: true,
    }, flag);
  }
  for (const flag of ['0', 'false', 'off', '']) {
    assert.equal(serverOptionsFromEnv({ CASHMERE_MCP_READ_ONLY: flag }).readOnly, false, flag);
  }

  assert.equal(serverOptionsFromEnv({ CASHMERE_MCP_MAX_AMOUNT: ' 250.5 ' }).maxAmount, '250.5');
  assert.equal(serverOptionsFromEnv({ CASHMERE_MCP_MAX_TOTAL: '1000' }).maxTotal, '1000');
  assert.deepEqual(serverOptionsFromEnv({ CASHMERE_MCP_ALLOWED_RECIPIENTS: ` ${SUI_RECIPIENT}, 0xabc ,` }).allowedRecipients, [SUI_RECIPIENT, '0xabc']);
  for (const cap of ['1e6', '-5', 'unlimited', '1,000']) {
    assert.throws(() => serverOptionsFromEnv({ CASHMERE_MCP_MAX_AMOUNT: cap }), /CASHMERE_MCP_MAX_AMOUNT/, cap);
    assert.throws(() => serverOptionsFromEnv({ CASHMERE_MCP_MAX_TOTAL: cap }), /CASHMERE_MCP_MAX_TOTAL/, cap);
  }
});

test('RPC and Gas API URLs must use https, and the error leaves the URL out', () => {
  const secretRpc = 'http://rpc.example/v2/api-key-1234567890';
  assert.throws(() => serverOptionsFromEnv({ CASHMERE_EVM_PRIVATE_KEY: KEY, CASHMERE_EVM_RPC_URL: secretRpc }), (err: Error) => {
    assert.equal(err.message, 'CASHMERE_EVM_RPC_URL must use https');
    return true;
  });
  assert.throws(() => serverOptionsFromEnv({ CASHMERE_GAS_API_URL: 'http://gas.example' }), /CASHMERE_GAS_API_URL must use https/);
  assert.equal(serverOptionsFromEnv({ CASHMERE_EVM_PRIVATE_KEY: KEY, CASHMERE_EVM_RPC_URL: 'http://127.0.0.1:8545' }).config.evm?.rpcUrl, 'http://127.0.0.1:8545');
});

// Stands in for CashmereCCTP, so cashmere_bridge runs without a chain: no test sends a real transfer
function stubCctp(transfer: (params: TransferParams) => Promise<TransferResult>) {
  const calls: TransferParams[] = [];
  const cctp = {
    simulate: () => { throw new Error('not used'); },
    transfer: (params: TransferParams) => { calls.push(params); return transfer(params); },
  };
  return { cctp, calls };
}

const sent = (params: TransferParams): TransferResult =>
  ({ txHash: `0x${'77'.repeat(32)}`, explorerUrl: 'https://basescan.org/tx/0x77', version: 'v2-fast', from: params.from, to: params.to });

test('cashmere_bridge refuses a recipient in the wrong format and amounts above the cap, before transferring', async () => {
  const { cctp, calls } = stubCctp(async params => sent(params));
  const client = await connect({ config: { evm: { privateKey: KEY } }, maxAmount: '100', cctp });
  const { tools } = await client.listTools();
  assert.match(tools.find(t => t.name === 'cashmere_bridge')!.description!, /at most 100 USDC per transfer\. .*allowDuplicate/);

  const bridge = (args: Record<string, string>) => client.callTool({ name: 'cashmere_bridge', arguments: args });
  // an EVM address padded to 32 bytes would mint to a Sui account nobody controls
  const wrongChain = await bridge({ from: 'base', to: 'sui', amount: '10', recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' });
  assert.equal(wrongChain.isError, true);
  assert.match(JSON.stringify(wrongChain.content), /Not sent: a sui recipient is a 0x address of 64 hex characters/);

  const overCap = await bridge({ from: 'base', to: 'sui', amount: '100.000001', recipient: SUI_RECIPIENT });
  assert.equal(overCap.isError, true);
  assert.match(JSON.stringify(overCap.content), /above this server's limit of 100 USDC/);
  assert.equal(calls.length, 0);

  const ok = await bridge({ from: 'base', to: 'sui', amount: '100', recipient: SUI_RECIPIENT });
  assert.notEqual(ok.isError, true);
  assert.deepEqual(json(ok), sent({ from: 'base', to: 'sui', amount: '100', recipient: SUI_RECIPIENT }));
  assert.deepEqual(calls, [{ from: 'base', to: 'sui', amount: '100', recipient: SUI_RECIPIENT }]);
  await client.close();
});

test('cashmere_bridge runs one transfer at a time and redacts keys from its errors', async () => {
  const events: string[] = [];
  const { cctp } = stubCctp(async params => {
    events.push(`start ${params.amount}`);
    await new Promise(r => setTimeout(r, 20));
    events.push(`end ${params.amount}`);
    if (params.amount === '2') throw new Error(`signer rejected key ${KEY}`);
    return sent(params);
  });
  const client = await connect({ config: { evm: { privateKey: KEY } }, cctp });
  const results = await Promise.all(['1', '2', '3'].map(amount =>
    client.callTool({ name: 'cashmere_bridge', arguments: { from: 'base', to: 'sui', amount, recipient: SUI_RECIPIENT } })));
  assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  assert.deepEqual(results.map(r => r.isError === true), [false, true, false]);
  assert.equal(JSON.stringify(results[1].content).includes(KEY.slice(2)), false);
  assert.match(JSON.stringify(results[1].content), /signer rejected key \[redacted\]/);
  await client.close();
});

test('tool errors never carry a configured private key', () => {
  const aptosKey = `0x${'cd'.repeat(64)}`;
  const config = { evm: { privateKey: KEY }, aptos: { privateKey: aptosKey } };
  const message = `bad key ${KEY}, ${KEY.slice(2).toUpperCase()}, ${aptosKey.slice(2)} or ${'cd'.repeat(32)}`;
  assert.equal(redact(message, config), 'bad key [redacted], [redacted], [redacted] or [redacted]');
});

test('cashmere_supported_routes follows the routing rules', async () => {
  const client = await connect({ config: {} });
  const routes = async (args: Record<string, string>) =>
    json(await client.callTool({ name: 'cashmere_supported_routes', arguments: args })).routes;

  const all = await routes({});
  const pairs = all.flatMap((r: { from: string; destinations: string[] }) => r.destinations.map(to => `${r.from}->${to}`));
  assert.equal(new Set(pairs).size, ALL_NETWORKS.length * (ALL_NETWORKS.length - 1));

  assert.deepEqual(await routes({ from: 'aptos' }), [{
    from: 'aptos',
    destinations: ALL_NETWORKS.filter(n => n !== 'aptos'),
    versions: ['v2-norm'],
    defaultVersion: 'v2-norm',
    estimatedDuration: { 'v2-norm': '~8 seconds' },
  }]);
  assert.deepEqual(await routes({ from: 'arc' }), [{
    from: 'arc',
    destinations: ALL_NETWORKS.filter(n => n !== 'arc'),
    versions: ['v2-norm'],
    defaultVersion: 'v2-norm',
    estimatedDuration: { 'v2-norm': '~1 second' },
  }]);
  assert.deepEqual(await routes({ from: 'base', to: 'sui' }), [{
    from: 'base',
    destinations: ['sui'],
    versions: ['v2-fast', 'v2-norm'],
    defaultVersion: 'v2-fast',
    estimatedDuration: { 'v2-fast': '~15 seconds', 'v2-norm': '~15 minutes' },
  }]);
  assert.equal((await routes({ to: 'solana' })).length, ALL_NETWORKS.length - 1);
  assert.deepEqual(await routes({ from: 'sui', to: 'sui' }), []);
  await client.close();
});

test('arguments are checked before anything runs', async () => {
  const client = await connect({ config: {} });
  for (const args of [
    { from: 'bitcoin', to: 'base', amount: '1' },
    { from: 'base', to: 'arbitrum', amount: '100 USDC' },
    { from: 'base', to: 'arbitrum', amount: '1.1234567' },
  ]) {
    const result = await client.callTool({ name: 'cashmere_simulate', arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  // no signer: the tool does not exist
  const bridge = await client.callTool({ name: 'cashmere_bridge', arguments: {} });
  assert.equal(bridge.isError, true);
  assert.match(JSON.stringify(bridge.content), /not found/);
  await client.close();
});

test('the stdio server starts from the bin without keys, bridge off', async () => {
  const client = await spawn();
  assert.deepEqual(await toolNames(client), ['cashmere_simulate', 'cashmere_supported_routes']);
  assert.equal(client.getServerVersion()?.name, 'cashmere');
  await client.close();
});

test('cashmere_simulate quotes live fees from the gas API', { skip: !process.env.CASHMERE_LIVE && 'set CASHMERE_LIVE=1' }, async () => {
  const client = await spawn({ CASHMERE_MCP_READ_ONLY: '1' });
  for (const [from, to, version] of [['base', 'arbitrum', 'v2-fast'], ['aptos', 'base', 'v2-norm'], ['solana', 'sui', 'v2-norm'], ['arc', 'base', 'v2-norm']]) {
    const result = await client.callTool({ name: 'cashmere_simulate', arguments: { from, to, amount: '10' } });
    assert.notEqual(result.isError, true, `${from} -> ${to}`);
    const sim = json(result);
    assert.equal(sim.supported, true);
    assert.equal(sim.version, version);
    assert.notEqual(sim.estimatedFee.cashmere, 'unable to fetch', `${from} -> ${to}`);
    assert.equal(typeof sim.estimatedFee.circleBurnBps, 'number');
  }
  await client.close();
});

test('a bridge call cancelled while it waits in the queue never sends', async () => {
  let release!: () => void;
  const { cctp, calls } = stubCctp(params => new Promise(resolve => { release = () => resolve(sent(params)); }));
  const client = await connect({ config: { evm: { privateKey: KEY } }, cctp });
  const bridge = (amount: string, signal?: AbortSignal) =>
    client.callTool({ name: 'cashmere_bridge', arguments: { from: 'base', to: 'sui', amount, recipient: SUI_RECIPIENT } }, undefined, { signal });

  const first = bridge('1');
  const controller = new AbortController();
  const second = bridge('2', controller.signal);
  await new Promise(r => setTimeout(r, 50));
  controller.abort();
  await assert.rejects(second);
  release();
  await first;
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(calls.map(c => c.amount), ['1']);
  await client.close();
});

test('an identical transfer within 10 minutes needs allowDuplicate, even after a failure', async () => {
  let clock = 1_800_000_000_000;
  let fail = false;
  const { cctp, calls } = stubCctp(async params => {
    if (fail) throw new Error('RPC timed out after broadcasting');
    return sent(params);
  });
  const client = await connect({ config: { evm: { privateKey: KEY } }, cctp, now: () => clock });
  const bridge = (args: Record<string, unknown>) =>
    client.callTool({ name: 'cashmere_bridge', arguments: { from: 'base', to: 'sui', amount: '5', recipient: SUI_RECIPIENT, ...args } });

  assert.notEqual((await bridge({})).isError, true);
  const again = await bridge({});
  assert.equal(again.isError, true);
  assert.match(JSON.stringify(again.content), /Not sent: an identical transfer was sent \(0x7777/);
  assert.notEqual((await bridge({ allowDuplicate: true })).isError, true);

  // A failure after signing may still be on chain, so it counts too
  clock += 11 * 60 * 1000;
  fail = true;
  assert.equal((await bridge({})).isError, true);
  fail = false;
  assert.match(JSON.stringify((await bridge({})).content), /failed and may still be on chain/);
  assert.equal(calls.length, 3);
  await client.close();
});

test('CASHMERE_MCP_MAX_TOTAL and CASHMERE_MCP_ALLOWED_RECIPIENTS bound what the bridge sends', async () => {
  const { cctp, calls } = stubCctp(async params => sent(params));
  const other = `0x${'6b'.repeat(32)}`;
  const client = await connect({ config: { evm: { privateKey: KEY } }, cctp, maxTotal: '150', allowedRecipients: [SUI_RECIPIENT.toUpperCase().replace('0X', '0x')] });
  const bridge = (amount: string, recipient = SUI_RECIPIENT) =>
    client.callTool({ name: 'cashmere_bridge', arguments: { from: 'base', to: 'sui', amount, recipient } });

  assert.match(JSON.stringify((await bridge('10', other)).content), /not one of this server's allowed recipients/);
  assert.notEqual((await bridge('100')).isError, true);
  assert.match(JSON.stringify((await bridge('60')).content), /has sent 100 USDC, and 60 more would pass its total limit of 150 USDC/);
  assert.notEqual((await bridge('50')).isError, true);
  assert.deepEqual(calls.map(c => c.amount), ['100', '50']);
  await client.close();
});
