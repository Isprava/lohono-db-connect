/**
 * NLQ Parser and Intent Resolver
 * 
 * Parses natural language queries and resolves them to QueryPlan objects
 * that reference existing metric schemas and time-range resolvers.
 * 
 * DOES NOT implement SQL generation or metric logic - only orchestration.
 */

import { resolveTimeRange } from '../time-range/index.js';
import {
  QueryPlan,
  QueryIntent,
  FunnelStage,
  MetricId,
  NLQTokens,
  DimensionType,
  TrendGranularity,
  STAGE_TERMS,
  INTENT_KEYWORDS,
  DIMENSION_KEYWORDS,
  AGGREGATION_KEYWORDS,
  COMPARISON_TYPE_MAP,
  ComparisonSpec
} from './types.js';
import { TimeRange, TimeRangeConfig, DEFAULT_TIME_RANGE_CONFIG } from '../time-range/types.js';

/**
 * Parse NLQ into tokens
 */
export function tokenize(query: string): NLQTokens {
  const normalized = query.toLowerCase().trim();
  const tokens = normalized.split(/\s+/);
  
  // Detect stages
  const stages: FunnelStage[] = [];
  for (const [stage, terms] of Object.entries(STAGE_TERMS)) {
    for (const term of terms) {
      if (normalized.includes(term)) {
        stages.push(stage as FunnelStage);
        break;
      }
    }
  }
  
  // Detect time expressions (delegate to time-range parser vocabulary)
  const time_expressions: string[] = [];
  const timePatterns = [
    /\b(mtd|wtd|qtd|ytd|fytd)\b/,
    /\b(this|last|next)\s+(week|month|quarter|year)\b/,
    /\b(last|past)\s+(\d+)\s+(day|week|month|quarter|year)s?\b/,
    /\b(between|from)\s+.+?\s+(and|to)\s+.+?\b/,
    /\b(since|after|until|before)\s+.+?\b/,
    /\b(wow|mom|qoq|yoy|dod)\b/
  ];
  
  for (const pattern of timePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      time_expressions.push(match[0]);
    }
  }
  
  // Detect dimensions
  const dimensions: DimensionType[] = [];
  for (const [dimension, keywords] of Object.entries(DIMENSION_KEYWORDS)) {
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        dimensions.push(dimension as DimensionType);
        break;
      }
    }
  }
  
  // Detect numbers
  const numbers: number[] = [];
  const numberMatches = normalized.match(/\b\d+\b/g);
  if (numberMatches) {
    numbers.push(...numberMatches.map(n => parseInt(n, 10)));
  }
  
  // Detect comparison keywords
  const comparison_keywords: string[] = [];
  for (const keyword of INTENT_KEYWORDS.COMPARISON) {
    if (normalized.includes(keyword)) {
      comparison_keywords.push(keyword);
    }
  }
  
  // Detect aggregation keywords
  const aggregation_keywords: string[] = [];
  for (const [agg, keywords] of Object.entries(AGGREGATION_KEYWORDS)) {
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        aggregation_keywords.push(agg);
        break;
      }
    }
  }
  
  return {
    stages,
    time_expressions,
    dimensions,
    numbers,
    comparison_keywords,
    aggregation_keywords,
    tokens
  };
}

/**
 * Detect query intent from tokens
 */
export function detectIntent(query: string, tokens: NLQTokens): QueryIntent {
  const normalized = query.toLowerCase();
  
  // Priority order matters - check most specific first
  
  // FUNNEL_SNAPSHOT: "show funnel", "pipeline overview"
  if (INTENT_KEYWORDS.FUNNEL_SNAPSHOT.some(kw => normalized.includes(kw))) {
    return 'FUNNEL_SNAPSHOT';
  }
  
  // CONVERSION: "conversion rate", "lead to prospect"
  if (INTENT_KEYWORDS.CONVERSION.some(kw => normalized.includes(kw)) || 
      normalized.match(/\b(lead|prospect|account)\s+to\s+(prospect|account|sale)/)) {
    return 'CONVERSION';
  }
  
  // DROPOFF: "dropoff", "leakage"
  if (INTENT_KEYWORDS.DROPOFF.some(kw => normalized.includes(kw))) {
    return 'DROPOFF';
  }
  
  // VELOCITY: "avg days", "time to", "how long"
  if (INTENT_KEYWORDS.VELOCITY.some(kw => normalized.includes(kw)) &&
      (normalized.includes('to') || normalized.includes('between'))) {
    return 'VELOCITY';
  }
  
  // AGING: "older than", "stuck", "aging"
  if (INTENT_KEYWORDS.AGING.some(kw => normalized.includes(kw)) ||
      normalized.match(/\b(older|stuck|idle)\s+(than|for|>)/)) {
    return 'AGING';
  }
  
  // COMPARISON: "vs", "compared to", "wow", "mom"
  if (tokens.comparison_keywords.length > 0) {
    return 'COMPARISON';
  }
  
  // RANKING: "top 10", "bottom 5", "highest"
  if (INTENT_KEYWORDS.RANKING.some(kw => normalized.includes(kw))) {
    return 'RANKING';
  }
  
  // BREAKDOWN: "by source", "breakdown by"
  if (tokens.dimensions.length > 0 && 
      (normalized.includes('by') || INTENT_KEYWORDS.BREAKDOWN.some(kw => normalized.includes(kw)))) {
    return 'BREAKDOWN';
  }
  
  // TREND: "daily", "weekly", "over time"
  if (INTENT_KEYWORDS.TREND.some(kw => normalized.includes(kw))) {
    return 'TREND';
  }
  
  // Default: STAGE_METRIC (simple count)
  return 'STAGE_METRIC';
}

/**
 * Resolve metric IDs based on intent and stages
 */
export function resolveMetricIds(intent: QueryIntent, stages: FunnelStage[]): MetricId[] {
  switch (intent) {
    case 'FUNNEL_SNAPSHOT':
      return [
        'FUNNEL.LEADS_ENTERED',
        'FUNNEL.PROSPECTS_ENTERED',
        'FUNNEL.ACCOUNTS_ENTERED',
        'FUNNEL.SALES_ENTERED'
      ];
    
    case 'CONVERSION':
      return ['FUNNEL.CONVERSION'];
    
    case 'DROPOFF':
      return ['FUNNEL.DROPOFF'];
    
    case 'VELOCITY':
      return ['FUNNEL.VELOCITY'];
    
    case 'AGING':
      return ['FUNNEL.AGING'];
    
    case 'TREND':
      return ['FUNNEL.TREND'];
    
    case 'STAGE_METRIC':
    case 'BREAKDOWN':
    case 'RANKING':
    case 'COMPARISON':
      // Map stages to metric IDs
      const metrics: MetricId[] = [];
      for (const stage of stages) {
        switch (stage) {
          case 'LEAD':
            metrics.push('FUNNEL.LEADS_ENTERED');
            break;
          case 'PROSPECT':
            metrics.push('FUNNEL.PROSPECTS_ENTERED');
            break;
          case 'ACCOUNT':
            metrics.push('FUNNEL.ACCOUNTS_ENTERED');
            break;
          case 'SALE':
            metrics.push('FUNNEL.SALES_ENTERED');
            break;
        }
      }
      return metrics;
    
    default:
      return [];
  }
}

/**
 * Extract trend granularity from query
 */
export function extractTrendGranularity(query: string): TrendGranularity | undefined {
  const normalized = query.toLowerCase();
  
  if (normalized.includes('daily') || normalized.includes('day by day')) {
    return 'day';
  } else if (normalized.includes('weekly') || normalized.includes('week by week')) {
    return 'week';
  } else if (normalized.includes('monthly') || normalized.includes('month by month')) {
    return 'month';
  } else if (normalized.includes('quarterly') || normalized.includes('quarter by quarter')) {
    return 'quarter';
  } else if (normalized.includes('yearly') || normalized.includes('year by year')) {
    return 'year';
  }
  
  return undefined;
}

/**
 * Extract conversion stages from query
 */
export function extractConversionStages(query: string, tokens: NLQTokens): { from_stage: FunnelStage; to_stage: FunnelStage } | undefined {
  const normalized = query.toLowerCase();
  
  // Pattern: "lead to prospect", "prospect to account", etc.
  const match = normalized.match(/\b(lead|prospect|account|sale)s?\s+to\s+(prospect|account|sale)s?\b/);
  
  if (match) {
    const from = match[1].toUpperCase() as FunnelStage;
    const to = match[2].toUpperCase() as FunnelStage;
    return { from_stage: from, to_stage: to };
  }
  
  // Fallback: use detected stages in order
  if (tokens.stages.length >= 2) {
    return {
      from_stage: tokens.stages[0],
      to_stage: tokens.stages[1]
    };
  }
  
  return undefined;
}

/**
 * Extract velocity stages and aggregation
 */
export function extractVelocitySpec(query: string, tokens: NLQTokens): { from_stage: FunnelStage; to_stage: FunnelStage; aggregation: 'avg' | 'median' | 'p90' | 'p95' } | undefined {
  const conversion = extractConversionStages(query, tokens);
  if (!conversion) return undefined;
  
  // Detect aggregation type
  let aggregation: 'avg' | 'median' | 'p90' | 'p95' = 'avg';
  
  if (tokens.aggregation_keywords.includes('median')) {
    aggregation = 'median';
  } else if (tokens.aggregation_keywords.includes('p90')) {
    aggregation = 'p90';
  } else if (tokens.aggregation_keywords.includes('p95')) {
    aggregation = 'p95';
  }
  
  return {
    ...conversion,
    aggregation
  };
}

/**
 * Extract aging specification
 */
export function extractAgingSpec(query: string, tokens: NLQTokens): { stage: FunnelStage; threshold_days: number; operator: '>' | '<' | '>=' | '<=' } | undefined {
  const normalized = query.toLowerCase();
  
  // Extract threshold days
  const thresholdMatch = normalized.match(/(\d+)\s*days?/);
  if (!thresholdMatch) return undefined;
  
  const threshold_days = parseInt(thresholdMatch[1], 10);
  
  // Extract operator
  let operator: '>' | '<' | '>=' | '<=' = '>';
  
  if (normalized.includes('older than') || normalized.includes('more than') || normalized.includes('>')) {
    operator = '>';
  } else if (normalized.includes('less than') || normalized.includes('<')) {
    operator = '<';
  } else if (normalized.includes('at least') || normalized.includes('>=')) {
    operator = '>=';
  } else if (normalized.includes('at most') || normalized.includes('<=')) {
    operator = '<=';
  }
  
  // Extract stage
  const stage = tokens.stages[0] || 'PROSPECT'; // Default to PROSPECT
  
  return {
    stage,
    threshold_days,
    operator
  };
}

/**
 * Extract ranking specification
 */
export function extractRankingSpec(query: string, tokens: NLQTokens, metric_ids: MetricId[]): { order_by: MetricId; direction: 'asc' | 'desc'; limit: number } | undefined {
  const normalized = query.toLowerCase();
  
  // Extract limit
  let limit = 10; // Default
  const limitMatch = normalized.match(/\b(top|bottom|first|last)\s+(\d+)\b/);
  if (limitMatch) {
    limit = parseInt(limitMatch[2], 10);
  } else if (tokens.numbers.length > 0) {
    limit = tokens.numbers[0];
  }
  
  // Extract direction
  let direction: 'asc' | 'desc' = 'desc';
  if (normalized.includes('bottom') || normalized.includes('worst') || normalized.includes('lowest')) {
    direction = 'asc';
  }
  
  // Use first metric ID as order_by
  const order_by = metric_ids[0];
  
  return {
    order_by,
    direction,
    limit
  };
}

/**
 * Resolve comparison spec
 */
export function resolveComparisonSpec(query: string, tokens: NLQTokens, base_time_range: TimeRange, config: TimeRangeConfig): ComparisonSpec | undefined {
  const normalized = query.toLowerCase();
  
  // Detect comparison type
  let comparison_type: string | undefined;
  
  for (const [key, value] of Object.entries(COMPARISON_TYPE_MAP)) {
    if (normalized.includes(key)) {
      comparison_type = value;
      break;
    }
  }
  
  if (!comparison_type) return undefined;
  
  // Resolve comparison time range using time-range resolver
  let compare_time_expression: string;
  
  switch (comparison_type) {
    case 'WoW':
      compare_time_expression = 'WoW';
      break;
    case 'MoM':
      compare_time_expression = 'MoM';
      break;
    case 'YoY':
      compare_time_expression = 'YoY';
      break;
    case 'DoD':
      compare_time_expression = 'DoD';
      break;
    case 'QoQ':
      compare_time_expression = 'QoQ';
      break;
    case 'vs_last_week':
      compare_time_expression = 'last week';
      break;
    case 'vs_last_month':
      compare_time_expression = 'last month';
      break;
    case 'vs_last_quarter':
      compare_time_expression = 'last quarter';
      break;
    case 'vs_last_year':
      compare_time_expression = 'last year';
      break;
    default:
      return undefined;
  }
  
  // Resolve using TimeRangeResolver
  const compare_range = resolveTimeRange(compare_time_expression, config);
  
  // If comparison has comparison field (WoW, MoM, etc.), use those ranges
  if (compare_range.comparison) {
    return {
      type: comparison_type,
      base_range: compare_range.comparison.base_range,
      compare_range: compare_range.comparison.compare_range
    };
  }
  
  // Otherwise, base is current period, compare is the resolved range
  return {
    type: comparison_type,
    base_range: base_time_range,
    compare_range: compare_range
  };
}

/**
 * Check if Isprava disclaimer is required
 * 
 * Returns true if "Isprava" (case-insensitive) is NOT in the query text
 */
export function requiresIspravaDisclaimer(query: string): boolean {
  return !/isprava/i.test(query);
}

/**
 * Generate output metadata with Isprava attribution/disclaimer
 */
export function generateOutputMeta(query: string): { disclaimer: string | null; scope?: string } {
  if (requiresIspravaDisclaimer(query)) {
    return {
      disclaimer: "Note: Results shown are for Isprava data only."
    };
  } else {
    return {
      disclaimer: null,
      scope: "Isprava (explicit in query)"
    };
  }
}

/**
 * Calculate confidence score
 */
export function calculateConfidence(tokens: NLQTokens, intent: QueryIntent): number {
  let confidence = 0.5; // Base confidence
  
  // Boost for detected stages
  if (tokens.stages.length > 0) {
    confidence += 0.2;
  }
  
  // Boost for time expressions
  if (tokens.time_expressions.length > 0) {
    confidence += 0.2;
  }
  
  // Boost for clear intent keywords
  const normalized = tokens.tokens.join(' ');
  const intentKeywords = INTENT_KEYWORDS[intent as keyof typeof INTENT_KEYWORDS];
  if (intentKeywords && intentKeywords.some(kw => normalized.includes(kw))) {
    confidence += 0.1;
  }
  
  return Math.min(confidence, 1.0);
}

/**
 * Main NLQ resolver - orchestrates all components
 */
export function resolveNLQ(
  query: string,
  timeRangeConfig: Partial<TimeRangeConfig> = {}
): QueryPlan {
  const config: TimeRangeConfig = {
    ...DEFAULT_TIME_RANGE_CONFIG,
    ...timeRangeConfig
  };
  
  // Step 1: Tokenize
  const tokens = tokenize(query);
  
  // Step 2: Detect intent
  const intent = detectIntent(query, tokens);
  
  // Step 3: Resolve stages (default to all stages for funnel snapshot)
  const stages = tokens.stages.length > 0 
    ? tokens.stages 
    : (intent === 'FUNNEL_SNAPSHOT' ? ['LEAD', 'PROSPECT', 'ACCOUNT', 'SALE'] as FunnelStage[] : []);
  
  // Step 4: Resolve time range using TimeRangeResolver
  const time_expression = tokens.time_expressions[0] || 'MTD'; // Default to MTD
  const time_range = resolveTimeRange(time_expression, config);
  
  // Step 5: Resolve metric IDs
  const metric_ids = resolveMetricIds(intent, stages);
  
  // Step 6: Build QueryPlan based on intent
  const plan: QueryPlan = {
    intent,
    metric_ids,
    stages,
    time_range,
    original_query: query,
    confidence: calculateConfidence(tokens, intent),
    output_meta: generateOutputMeta(query)
  };
  
  // Intent-specific additions
  switch (intent) {
    case 'BREAKDOWN':
      plan.group_by = tokens.dimensions;
      break;
    
    case 'TREND':
      plan.trend_granularity = extractTrendGranularity(query) || 'day';
      break;
    
    case 'CONVERSION':
      plan.conversion = extractConversionStages(query, tokens);
      break;
    
    case 'VELOCITY':
      plan.velocity = extractVelocitySpec(query, tokens);
      break;
    
    case 'AGING':
      plan.aging = extractAgingSpec(query, tokens);
      break;
    
    case 'RANKING':
      plan.ranking = extractRankingSpec(query, tokens, metric_ids);
      plan.group_by = tokens.dimensions;
      break;
    
    case 'COMPARISON':
      plan.comparison = resolveComparisonSpec(query, tokens, time_range, config);
      break;
  }
  
  return plan;
}
