import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermesSystemPrompt, hermesToolResponse, hermesTools, parseHermesToolCalls } from './hermes';

test('tools are OpenAI-style functions; read-only leaves the bridge out', () => {
  assert.deepEqual(hermesTools().map(t => [t.type, t.function.name]), [
    ['function', 'cashmere_simulate'],
    ['function', 'cashmere_supported_routes'],
    ['function', 'cashmere_bridge'],
  ]);
  assert.deepEqual(hermesTools({ readOnly: true }).map(t => t.function.name), ['cashmere_simulate', 'cashmere_supported_routes']);
});

test('the system prompt lists each tool as one JSON line inside <tools>', () => {
  const prompt = hermesSystemPrompt(hermesTools(), 'You pay invoices.');
  assert.ok(prompt.startsWith('You pay invoices.\n\n# Tools\n\n'));
  const lines = prompt.split('<tools>\n')[1].split('\n</tools>')[0].split('\n');
  assert.deepEqual(lines.map(line => JSON.parse(line)), hermesTools());
  // json.dumps spacing, as the chat template renders it
  assert.ok(lines[0].startsWith('{"type": "function", "function": {"name": "cashmere_simulate", '));
  assert.ok(prompt.endsWith('<tool_call>\n{"name": "<function-name>", "arguments": <args-json-object>}\n</tool_call>'));
});

test('tool calls are read from <tool_call> blocks, never from <think>', () => {
  const reply = [
    '<think>maybe <tool_call>{"name": "cashmere_bridge", "arguments": {"amount": "999"}}</tool_call></think>',
    'Let me check.',
    '<tool_call>\n{"name": "cashmere_simulate", "arguments": {"from": "base", "to": "solana", "amount": "25"}}\n</tool_call>',
    '<tool_call>\n{"name": "cashmere_supported_routes", "arguments": "{\\"from\\": \\"sui\\"}"}\n',
  ].join('\n');
  assert.deepEqual(parseHermesToolCalls(reply), [
    { name: 'cashmere_simulate', arguments: { from: 'base', to: 'solana', amount: '25' } },
    { name: 'cashmere_supported_routes', arguments: { from: 'sui' } },
  ]);
  assert.deepEqual(parseHermesToolCalls('No tools needed.'), []);
  // An unclosed <think> means the reply was cut off mid-thought: nothing in it runs
  assert.deepEqual(parseHermesToolCalls('<think><tool_call>{"name": "cashmere_bridge", "arguments": {}}</tool_call>'), []);
  assert.throws(() => parseHermesToolCalls('<tool_call>{"name": "cashmere_bridge", </tool_call>'), /Not a Hermes tool call/);
  assert.throws(() => parseHermesToolCalls('<tool_call>{"arguments": {}}</tool_call>'), /Not a Hermes tool call/);
});

test('tool responses wrap name and content in <tool_response>', () => {
  assert.equal(
    hermesToolResponse('cashmere_simulate', { supported: true, estimatedFee: { circleBurnBps: null } }),
    '<tool_response>\n{"name": "cashmere_simulate", "content": {"supported": true, "estimatedFee": {"circleBurnBps": null}}}\n</tool_response>',
  );
});
