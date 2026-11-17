// The MCP harness of the r4 tests (the same as write.test.ts): the fake world, the API fixtures, a recording signer, an
// in-memory client. No network, no real key.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decodeFunctionData, type Abi, type Hex } from 'viem';
import { createCashmereMcpServer, type CashmereMcpServerOptions } from '../../mcp/server';
import { GoatApi } from '../api';
import { NOW_SEC, TEST_KEY, V4_POS, apiWorld, writeWorld, type FakeAnswer } from './kit';

type Route = FakeAnswer | ((init: { method: string; headers: Record<string, string>; body?: string }) => FakeAnswer);

export function setup(o: { v4Range?: [number, number]; api?: Record<string, Route> } = {}) {
  const w = writeWorld({ v4Range: o.v4Range ?? [-199200, -198600] });
  const api = apiWorld({ 'POST /automation/permits': { status: 200, body: { ok: true } }, [`DELETE /automation/permits/${V4_POS}`]: { status: 200, body: { deleted: true } }, ...o.api });
  const clock = NOW_SEC * 1000;
  const goatApi = new GoatApi({ fetch: api.fetch, now: () => clock, sleep: async () => {} });
  const options: CashmereMcpServerOptions = {
    config: { evm: { privateKey: TEST_KEY } },
    goatlp: { deps: { api: goatApi, chain: w.chain, signer: w.signer, now: () => clock } },
  };
  return { ...w, api, options };
}

export async function connect(options: CashmereMcpServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createCashmereMcpServer(options).connect(serverTransport);
  const client = new Client({ name: 'goatlp-r4-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

export async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await c.callTool({ name, arguments: args });
  const [content] = r.content as { type: string; text: string }[];
  if (r.isError) return { error: content.text };
  return JSON.parse(content.text) as Record<string, unknown>;
}

export const fn = (abi: readonly unknown[], data: Hex) => (decodeFunctionData({ abi: abi as Abi, data }) as { functionName: string; args: readonly unknown[] });
export const actions = (plan: Record<string, unknown>) => ((plan.steps ?? []) as Record<string, unknown>[]).map((x) => x.action);
