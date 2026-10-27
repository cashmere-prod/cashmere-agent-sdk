// The parts of api.cashmere.exchange's answers the Goat LP tools read. Every field is optional where the service may leave
// it out; the tools never invent a missing number.

export interface ApiToken {
  address: string;
  symbol?: string | null;
  name?: string | null;
  decimals?: number | null;
  is_native?: boolean;
  price?: number | null;
  price_flag?: string | null;
}

export interface ApiDiscoverPool {
  address: string;
  exchange: string;
  fee_tier: string | number;
  token0: string;
  token1: string;
  token0_symbol?: string | null;
  token1_symbol?: string | null;
  hooks?: string | null;
  tick_spacing?: number | null;
  pool_tvl?: number | null;
  tvl_current?: number | null;
  pool_volume?: number | null;
  fees?: number | null;
  pool_fees_apr?: number | null;
  pool_rewards_apr?: number | null;
  swap_tax?: { pct?: number | null; label_en?: string | null } | null;
  price_stale?: boolean | null;
  flag_reasons?: string[] | null;
}
export interface ApiDiscoverResponse { success?: boolean; total_count?: number; data: ApiDiscoverPool[] }

export interface ApiPoolDetail {
  address: string;
  exchange: string;
  fee_tier: number;
  tick_spacing: number;
  hooks: string | null;
  is_dynamic_fee?: boolean | null;
  token0: string;
  token1: string;
  tokens?: Record<string, ApiToken>;
  sqrt_price?: string;
  tick?: number;
  liquidity?: string;
  pool_price?: number | null;
  tvl_usd?: number | null;
  tvl_token0?: string;
  tvl_token1?: string;
  token0_symbol?: string;
  token1_symbol?: string;
  swap_tax?: { pct?: number | null; label_en?: string | null } | null;
  price_stale?: boolean | null;
  lp_fee_charged?: { last_pips?: number | null; avg_pips?: number | null; basis?: string | null } | null;
  last_24h?: {
    volume_usd?: number | null; fees_usd?: number | null; fees_lp_usd?: number | null; fees_apr?: number | null; fees_apr_gross?: number | null;
    rewards_apr?: number | null; tvl_usd?: number | null; apr_tvl_basis?: string | null;
  } | null;
}

export interface ApiPerf { pnl?: number | null; roi?: number | null; apr?: number | null; pool_pnl?: number | null; pool_apr?: number | null; il?: number | null; fee_apr?: number | null; apr_reason?: string | null }

export interface ApiCashFlow {
  type: string;
  timestamp: number;
  block_number?: number;
  tx_hash?: string | null;
  amount?: string;
  amount_usd?: number | null;
  amount0?: string;
  amount1?: string;
  liquidity?: string;
}

export interface ApiPosition {
  exchange: string;
  nft_id: number | string;
  pool: string;
  fee_tier: number;
  token0: string;
  token1: string;
  tokens?: Record<string, ApiToken>;
  owner: string;
  liquidity?: string;
  tick_lower: number;
  tick_upper: number;
  pool_tick?: number;
  price_lower?: number;
  price_upper?: number;
  pool_price?: number;
  in_range?: boolean;
  exited?: boolean;
  underlying_value?: number | null;
  uncollected_fees_value?: number | null;
  uncollected_fees0?: string;
  uncollected_fees1?: string;
  current_amount0?: string;
  current_amount1?: string;
  fees_value?: number | null;
  performance?: { hodl?: ApiPerf; usd?: ApiPerf; eth?: ApiPerf };
  performance_unavailable?: unknown;
  autocompounding?: boolean;
  age?: number;
  closed_at_ts?: number | null;
  cash_flows?: ApiCashFlow[];
  ledger_withheld?: { message?: string } | null;
}
export interface ApiPositionsResponse {
  success?: boolean;
  data: ApiPosition[];
  pagination?: { page_size?: number; total_count?: number; has_next?: boolean; next_cursor?: string | null };
  exited_count?: number;
}

export interface ApiAutomationPolicy {
  keeper?: { min_position_display_usd?: number | null } | null;
  range_fee_pct?: number;
  exit_fee_pct?: number;
  compound_take_pct?: number;
}

export interface ApiTokenPrice { address?: string; symbol?: string; decimals?: number; price?: number | null; price_status?: string | null }
