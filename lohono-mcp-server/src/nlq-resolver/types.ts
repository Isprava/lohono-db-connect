/**
 * NLQ Intent Resolver Types
 * 
 * Maps Natural Language Queries to QueryPlan objects that reference
 * existing metric schemas and time-range resolvers.
 */

import { TimeRange } from '../time-range/types.js';

/**
 * Intent types for NLQ queries
 */
export type QueryIntent =
  | 'STAGE_METRIC'      // Single stage count (Leads MTD)
  | 'FUNNEL_SNAPSHOT'   // All stages (Show funnel MTD)
  | 'TREND'             // Time series (Daily leads last 14 days)
  | 'BREAKDOWN'         // Group by dimension (Sales by source)
  | 'CONVERSION'        // Conversion rate (Lead to prospect conversion)
  | 'DROPOFF'           // Leakage analysis (Where is drop-off highest)
  | 'VELOCITY'          // Time between stages (Avg days lead to sale)
  | 'AGING'             // Stuck records (Prospects older than 14 days)
  | 'COMPARISON'        // Period comparison (Sales MTD vs last month)
  | 'RANKING';          // Top N (Top 10 sources by sales)

/**
 * Funnel stages
 */
export type FunnelStage = 'LEAD' | 'PROSPECT' | 'ACCOUNT' | 'SALE';

/**
 * Metric identifiers (references to existing MetricRegistry)
 */
export type MetricId =
  | 'FUNNEL.LEADS_ENTERED'
  | 'FUNNEL.PROSPECTS_ENTERED'
  | 'FUNNEL.ACCOUNTS_ENTERED'
  | 'FUNNEL.SALES_ENTERED'
  | 'FUNNEL.CONVERSION'
  | 'FUNNEL.DROPOFF'
  | 'FUNNEL.VELOCITY'
  | 'FUNNEL.AGING'
  | 'FUNNEL.TREND';

/**
 * Trend granularity
 */
export type TrendGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Dimension for breakdowns
 */
export type DimensionType = 
  | 'source'
  | 'agent'
  | 'location'
  | 'property_type'
  | 'stage';

/**
 * Comparison metadata
 */
export interface ComparisonSpec {
  /** Comparison type (e.g., WoW, MoM, YoY) */
  type: string;
  /** Base period time range */
  base_range: TimeRange;
  /** Comparison period time range */
  compare_range: TimeRange;
}

/**
 * Ranking specification
 */
export interface RankingSpec {
  /** Order by metric (asc/desc) */
  order_by: MetricId;
  /** Order direction */
  direction: 'asc' | 'desc';
  /** Limit results */
  limit: number;
}

/**
 * Filter specification
 */
export interface FilterSpec {
  /** Field to filter on */
  field: string;
  /** Operator */
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'IN' | 'NOT IN' | 'LIKE';
  /** Value(s) */
  value: string | number | string[] | number[];
}

/**
 * Query Plan - output contract
 * References existing metric schemas and time-range resolvers
 */
export interface QueryPlan {
  /** Intent type */
  intent: QueryIntent;
  
  /** Metric IDs (references to MetricRegistry) */
  metric_ids: MetricId[];
  
  /** Stages involved */
  stages: FunnelStage[];
  
  /** Time range (from TimeRangeResolver) */
  time_range: TimeRange;
  
  /** Group by dimensions (for BREAKDOWN) */
  group_by?: DimensionType[];
  
  /** Filters */
  filters?: FilterSpec[];
  
  /** Comparison spec (for COMPARISON intent) */
  comparison?: ComparisonSpec;
  
  /** Ranking spec (for RANKING intent) */
  ranking?: RankingSpec;
  
  /** Trend granularity (for TREND intent) */
  trend_granularity?: TrendGranularity;
  
  /** Conversion spec (for CONVERSION intent) */
  conversion?: {
    from_stage: FunnelStage;
    to_stage: FunnelStage;
  };
  
  /** Velocity spec (for VELOCITY intent) */
  velocity?: {
    from_stage: FunnelStage;
    to_stage: FunnelStage;
    aggregation: 'avg' | 'median' | 'p90' | 'p95';
  };
  
  /** Aging spec (for AGING intent) */
  aging?: {
    stage: FunnelStage;
    threshold_days: number;
    operator: '>' | '<' | '>=' | '<=';
  };
  
  /** Original NLQ text */
  original_query: string;
  
  /** Confidence score (0-1) */
  confidence: number;
  
  /** Output metadata (disclaimers, attribution, scope) */
  output_meta: {
    /** Disclaimer about data scope */
    disclaimer: string | null;
    /** Scope explicitly mentioned in query */
    scope?: string;
  };
}

/**
 * Detected tokens from NLQ parsing
 */
export interface NLQTokens {
  /** Detected stages */
  stages: FunnelStage[];
  
  /** Detected time expressions */
  time_expressions: string[];
  
  /** Detected dimensions */
  dimensions: DimensionType[];
  
  /** Detected numbers (for thresholds, limits) */
  numbers: number[];
  
  /** Detected comparison keywords */
  comparison_keywords: string[];
  
  /** Detected aggregation keywords */
  aggregation_keywords: string[];
  
  /** Original tokens */
  tokens: string[];
}

/**
 * Stage term vocabulary
 */
export const STAGE_TERMS: Record<FunnelStage, string[]> = {
  LEAD: ['lead', 'leads', 'enquiry', 'enquiries', 'inquiry', 'inquiries'],
  PROSPECT: ['prospect', 'prospects', 'qualified'],
  ACCOUNT: ['account', 'accounts', 'onboarded'],
  SALE: ['sale', 'sales', 'won', 'booking', 'bookings', 'deal', 'deals', 'maal_laao', 'maal laao']
};

/**
 * Intent keywords
 */
export const INTENT_KEYWORDS = {
  FUNNEL_SNAPSHOT: ['funnel', 'pipeline', 'overview', 'snapshot'],
  TREND: ['daily', 'weekly', 'monthly', 'quarterly', 'trend', 'over time', 'time series'],
  BREAKDOWN: ['by', 'breakdown', 'split', 'group', 'segmented'],
  CONVERSION: ['conversion', 'convert', 'conversion rate', 'converted'],
  DROPOFF: ['dropoff', 'drop-off', 'leakage', 'drop', 'lost', 'attrition'],
  VELOCITY: ['velocity', 'time', 'days', 'duration', 'speed', 'how long', 'avg time', 'median time'],
  AGING: ['aging', 'stuck', 'older than', 'stale', 'idle', 'waiting'],
  COMPARISON: ['vs', 'versus', 'compared to', 'compare', 'wow', 'mom', 'yoy', 'dod', 'qoq'],
  RANKING: ['top', 'bottom', 'best', 'worst', 'highest', 'lowest', 'rank']
} as const;

/**
 * Dimension keywords
 */
export const DIMENSION_KEYWORDS: Record<DimensionType, string[]> = {
  source: ['source', 'sources', 'channel', 'channels', 'origin'],
  agent: ['agent', 'agents', 'rep', 'reps', 'sales rep', 'salesperson'],
  location: ['location', 'locations', 'city', 'cities', 'region', 'regions'],
  property_type: ['property type', 'property types', 'type', 'types'],
  stage: ['stage', 'stages', 'status']
};

/**
 * Aggregation keywords
 */
export const AGGREGATION_KEYWORDS = {
  avg: ['avg', 'average', 'mean'],
  median: ['median', 'middle', 'mid'],
  p90: ['p90', '90th percentile', '90%'],
  p95: ['p95', '95th percentile', '95%'],
  sum: ['total', 'sum'],
  count: ['count', 'number of', 'how many']
} as const;

/**
 * Comparison keywords mapping
 */
export const COMPARISON_TYPE_MAP: Record<string, string> = {
  'wow': 'WoW',
  'week over week': 'WoW',
  'mom': 'MoM',
  'month over month': 'MoM',
  'yoy': 'YoY',
  'year over year': 'YoY',
  'dod': 'DoD',
  'day over day': 'DoD',
  'qoq': 'QoQ',
  'quarter over quarter': 'QoQ',
  'vs last week': 'vs_last_week',
  'vs last month': 'vs_last_month',
  'vs last quarter': 'vs_last_quarter',
  'vs last year': 'vs_last_year'
};
