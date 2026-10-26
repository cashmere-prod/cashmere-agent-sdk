import { bridgeToolSchema, simulateToolSchema, supportedRoutesToolSchema } from '../tool-schema';

export interface HermesTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface HermesToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// OpenAI-style tool list: what Hermes chat templates and Hermes tool parsers (vLLM, SGLang, llama.cpp) take
export function hermesTools(options: { readOnly?: boolean } = {}): HermesTool[] {
  const schemas = [simulateToolSchema, supportedRoutesToolSchema, ...(options.readOnly ? [] : [bridgeToolSchema])];
  return schemas.map(schema => ({ type: 'function', function: schema }));
}

// json.dumps spacing, which the Hermes chat templates render tools with
function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

// For prompting a Hermes model without a chat template: the tools section of the Hermes 4 chat template.
// Hermes 2 Pro and 3 use the same <tools>, <tool_call> and <tool_response> tags.
export function hermesSystemPrompt(
  tools: HermesTool[] = hermesTools(),
  systemPrompt = 'You are Hermes, created by Nous Research.',
): string {
  return `${systemPrompt}\n\n# Tools\n\n`
    + 'You are a function calling AI model. You may call one or more functions to assist with the user query.\n\n'
    + 'You are provided with function signatures within <tools></tools> XML tags:\n'
    + `<tools>${tools.map(tool => `\n${pyJson(tool)}`).join('')}\n</tools>\n\n`
    + 'For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n'
    + '<tool_call>\n{"name": "<function-name>", "arguments": <args-json-object>}\n</tool_call>';
}

function parseCall(body: string): HermesToolCall {
  try {
    const call = JSON.parse(body);
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments ?? {};
    if (typeof call.name === 'string' && args !== null && typeof args === 'object' && !Array.isArray(args)) {
      return { name: call.name, arguments: args };
    }
  } catch {
    // reported below
  }
  throw new Error(`Not a Hermes tool call ({"name": ..., "arguments": {...}}): ${body.trim()}`);
}

// The <tool_call> blocks of a Hermes reply, the last one possibly cut off by a stop token.
// Calls inside <think> are reasoning, not calls, and are skipped.
export function parseHermesToolCalls(reply: string): HermesToolCall[] {
  const text = reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');
  return [...text.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)].map(match => parseCall(match[1]));
}

// A tool result for the model's next turn: send it as a `tool` message to Hermes 2 Pro and 3, as a `user` message to
// Hermes 4. With a chat template, pass only the JSON inside: the template adds the tags.
export function hermesToolResponse(name: string, content: unknown): string {
  return `<tool_response>\n${pyJson({ name, content })}\n</tool_response>`;
}
