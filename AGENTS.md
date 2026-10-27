# AGENTS.md

Instructions for coding agents working in this repository. For agents that send payments with the SDK, see
`skills/cashmere-usdc-transfers/SKILL.md` instead.

## What this is

`@cashmerelabs/cashmere-agent-sdk` is a TypeScript SDK and MCP server for cross-chain USDC transfers over Circle CCTP,
through the Cashmere contracts, on 14 EVM chains, Solana, Aptos and Sui. It signs and sends real transactions.

## Layout

- `src/index.ts`: `CashmereCCTP` (`transfer`, `simulate`) and the public exports.
- `src/chains/*.ts`: transaction builders per chain. `src/signers/*.ts`: key parsing per chain.
- `src/utils/routing.ts`: which CCTP version each route uses. The only source of truth for routing.
- `src/constants.ts`: CCTP domains, contract and package addresses, default RPCs, durations.
- `src/tool-schema.ts`: tool names, descriptions and schemas, shared by the MCP server, the OpenAI and Hermes exports
  and LangChain.
- `src/mcp/`: the stdio MCP server. `cli.ts` is the `cashmere-mcp` bin.
- `src/goatlp/`: the Goat LP tools of the MCP server (Robinhood Chain): the API client, the chain reads and code-hash
  pins, the builders and decode checks, the plan / execute flow and the tool registration. Tests run on a fake chain
  and fake API answers in `src/goatlp/__fixtures__/`.
- `src/tools/`: the LangChain and Hermes integrations.
- `skills/cashmere-usdc-transfers/`: the agent skill (Agent Skills format) for running payments with the MCP tools.
- `skills/goat-lp/`: the agent skill for the Goat LP tools.
- `.claude-plugin/`: Claude Code plugin and marketplace manifests. The repository root is the plugin.
- `SKILL.md`: developer reference for the contracts, shipped in the npm package. Not an Agent Skills skill.

## Commands

- `npm ci`, then `npm run build` (tsc to `dist/`) and `npm test` (node:test through tsx, offline).
- `CASHMERE_LIVE=1 npm test` adds read-only mainnet checks: the Gas API, Circle Iris, the Aptos ABI and the Sui
  functions. Nothing is signed or sent.
- `claude plugin validate .` checks the plugin manifests.

## Rules

- Never send a real transfer from a test or script. Tests reach `cashmere_bridge` and `transfer()` only with stubs, or
  with throwaway keys and unreachable hosts.
- The same for Goat LP: tests never send a transaction, sign with a real key or write to `api.cashmere.exchange`.
- Never print, log or commit a private key, error messages included. The MCP server redacts configured keys from tool
  errors: keep it that way.
- The MCP server's stdout carries JSON-RPC. Log to stderr only.
- The build is CommonJS (`module: nodenext`). `@mysten/sui` is ESM and loaded with `require()`; its dependencies need
  Node.js 22+.
- The MCP server reads only `CASHMERE_` environment variables: Claude Code passes the user's shell environment to MCP
  servers, and a key exported there for other tools must not become a wallet the agent can spend from.
- Tests live in `src/**/*.test.ts`, and each new file goes into the `test` script in `package.json`.

## Keep in sync

When routing, chains, fees or tool behaviour change, update every place that restates them:

- `README.md`: Supported Routes, Version Auto-Resolution, MCP Server.
- `SKILL.md` sections 2 and 10. Section 10 is generated from `src/utils/routing.ts`.
- `skills/cashmere-usdc-transfers/`: speed, fees, chains, setup.
- The tool descriptions in `src/tool-schema.ts`.
- The docs site: `developers/agent-integration.mdx` in `cashmere-prod/docs-prod2`.

## Release

1. Bump `version` in `package.json`. The MCP server reports it.
2. Move the pinned version in `npx -y @cashmerelabs/cashmere-agent-sdk@<version>` to it everywhere: `.claude-plugin/plugin.json`,
   `README.md`, `skills/cashmere-usdc-transfers/` and the docs site. The server holds keys, so the docs pin exact versions.
3. Run `npm run build && npm test && CASHMERE_LIVE=1 npm test`.
4. The owner runs `npm publish`. `npx` and the Claude Code plugin run the published package, so nothing that documents
   a new feature should ship before it.
