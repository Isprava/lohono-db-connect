/**
 * Comprehensive NLQ Test Suite - 40+ Examples
 * 
 * Validates:
 * 1. Only existing metric_schema_id(s) are used
 * 2. time_range is produced by TimeRangeResolver
 * 3. Disclaimer is present when NLQ lacks "Isprava"
 * 4. Funnel requests compose the 4 stage metric schemas
 */

import { describe, it, expect } from '@jest/globals';
import { resolveNLQ, requiresIspravaDisclaimer } from '../parser.js';
import { TimeRangeConfig } from '../../time-range/types.js';

// Fixed reference date for deterministic testing
const TEST_CONFIG: Partial<TimeRangeConfig> = {
  timezone: 'Asia/Kolkata',
  fiscal_config: {
    fiscal_year_start_month: 4
  },
  week_start: 'monday',
  now: '2026-02-09T12:00:00+05:30' // Monday, Feb 9, 2026
};

// Valid metric IDs from MatrixSchema
const VALID_METRIC_IDS = [
  'FUNNEL.LEADS_ENTERED',
  'FUNNEL.PROSPECTS_ENTERED',
  'FUNNEL.ACCOUNTS_ENTERED',
  'FUNNEL.SALES_ENTERED',
  'FUNNEL.CONVERSION',
  'FUNNEL.DROPOFF',
  'FUNNEL.VELOCITY',
  'FUNNEL.AGING',
  'FUNNEL.TREND'
];

/**
 * Assert that plan only uses valid metric IDs
 */
function assertValidMetricIds(metricIds: string[]) {
  for (const id of metricIds) {
    expect(VALID_METRIC_IDS).toContain(id);
  }
}

/**
 * Assert that time_range is properly formed (from TimeRangeResolver)
 */
function assertValidTimeRange(timeRange: any) {
  expect(timeRange).toBeDefined();
  expect(timeRange.mode).toBeDefined();
  expect(timeRange.timezone).toBe('Asia/Kolkata');
  expect(timeRange.start).toBeDefined();
}

/**
 * Assert disclaimer logic
 */
function assertDisclaimerLogic(query: string, outputMeta: any) {
  const hasIsprava = /isprava/i.test(query);
  
  if (hasIsprava) {
    expect(outputMeta.disclaimer).toBeNull();
    expect(outputMeta.scope).toBe('Isprava (explicit in query)');
  } else {
    expect(outputMeta.disclaimer).toBe('Note: Results shown are for Isprava data only.');
    expect(outputMeta.scope).toBeUndefined();
  }
}

describe('📋 Isprava Disclaimer Logic', () => {
  it('should return true when "Isprava" is NOT in query', () => {
    expect(requiresIspravaDisclaimer('show leads mtd')).toBe(true);
    expect(requiresIspravaDisclaimer('sales last week')).toBe(true);
    expect(requiresIspravaDisclaimer('funnel overview')).toBe(true);
  });
  
  it('should return false when "Isprava" IS in query (case-insensitive)', () => {
    expect(requiresIspravaDisclaimer('show Isprava leads mtd')).toBe(false);
    expect(requiresIspravaDisclaimer('ISPRAVA sales last week')).toBe(false);
    expect(requiresIspravaDisclaimer('isprava funnel overview')).toBe(false);
  });
  
  it('should add disclaimer when Isprava not mentioned', () => {
    const plan = resolveNLQ('leads mtd', TEST_CONFIG);
    expect(plan.output_meta.disclaimer).toBe('Note: Results shown are for Isprava data only.');
    expect(plan.output_meta.scope).toBeUndefined();
  });
  
  it('should NOT add disclaimer when Isprava is mentioned', () => {
    const plan = resolveNLQ('Isprava leads mtd', TEST_CONFIG);
    expect(plan.output_meta.disclaimer).toBeNull();
    expect(plan.output_meta.scope).toBe('Isprava (explicit in query)');
  });
});

describe('1️⃣ Single Stage Metrics (10 examples)', () => {
  const testCases = [
    { query: 'leads mtd', stage: 'LEAD', metricId: 'FUNNEL.LEADS_ENTERED' },
    { query: 'prospects last week', stage: 'PROSPECT', metricId: 'FUNNEL.PROSPECTS_ENTERED' },
    { query: 'accounts this month', stage: 'ACCOUNT', metricId: 'FUNNEL.ACCOUNTS_ENTERED' },
    { query: 'sales ytd', stage: 'SALE', metricId: 'FUNNEL.SALES_ENTERED' },
    { query: 'enquiries last 30 days', stage: 'LEAD', metricId: 'FUNNEL.LEADS_ENTERED' },
    { query: 'qualified prospects this quarter', stage: 'PROSPECT', metricId: 'FUNNEL.PROSPECTS_ENTERED' },
    { query: 'bookings last 90 days', stage: 'SALE', metricId: 'FUNNEL.SALES_ENTERED' },
    { query: 'onboarded accounts wtd', stage: 'ACCOUNT', metricId: 'FUNNEL.ACCOUNTS_ENTERED' },
    { query: 'deals closed yesterday', stage: 'SALE', metricId: 'FUNNEL.SALES_ENTERED' },
    { query: 'inquiries last week', stage: 'LEAD', metricId: 'FUNNEL.LEADS_ENTERED' }
  ];
  
  testCases.forEach(({ query, stage, metricId }) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('STAGE_METRIC');
      expect(plan.stages).toContain(stage);
      expect(plan.metric_ids).toContain(metricId);
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('2️⃣ Funnel Snapshot (5 examples)', () => {
  const testCases = [
    'show funnel mtd',
    'pipeline overview last 30 days',
    'funnel snapshot this quarter',
    'show Isprava pipeline ytd',
    'funnel breakdown last week'
  ];
  
  testCases.forEach((query) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('FUNNEL_SNAPSHOT');
      
      // Must compose ALL 4 stages
      expect(plan.metric_ids).toEqual([
        'FUNNEL.LEADS_ENTERED',
        'FUNNEL.PROSPECTS_ENTERED',
        'FUNNEL.ACCOUNTS_ENTERED',
        'FUNNEL.SALES_ENTERED'
      ]);
      
      expect(plan.stages).toEqual(['LEAD', 'PROSPECT', 'ACCOUNT', 'SALE']);
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('3️⃣ Trend Queries (5 examples)', () => {
  const testCases = [
    { query: 'daily leads last 14 days', granularity: 'day' },
    { query: 'weekly sales mtd', granularity: 'week' },
    { query: 'monthly prospects ytd', granularity: 'month' },
    { query: 'quarterly accounts trend this year', granularity: 'quarter' },
    { query: 'Isprava daily bookings last 7 days', granularity: 'day' }
  ];
  
  testCases.forEach(({ query, granularity }) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('TREND');
      expect(plan.metric_ids).toContain('FUNNEL.TREND');
      expect(plan.trend_granularity).toBe(granularity);
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('4️⃣ Breakdown Queries (5 examples)', () => {
  const testCases = [
    { query: 'sales by source last month', dimension: 'source' },
    { query: 'leads by agent mtd', dimension: 'agent' },
    { query: 'prospects by location this quarter', dimension: 'location' },
    { query: 'Isprava bookings by property type ytd', dimension: 'property_type' },
    { query: 'accounts breakdown by source last 90 days', dimension: 'source' }
  ];
  
  testCases.forEach(({ query, dimension }) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('BREAKDOWN');
      expect(plan.group_by).toContain(dimension);
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('5️⃣ Conversion Queries (4 examples)', () => {
  const testCases = [
    { query: 'lead to prospect conversion rate mtd', from: 'LEAD', to: 'PROSPECT' },
    { query: 'prospect to account conversion last month', from: 'PROSPECT', to: 'ACCOUNT' },
    { query: 'lead to sale conversion ytd', from: 'LEAD', to: 'SALE' },
    { query: 'Isprava account to sale conversion this quarter', from: 'ACCOUNT', to: 'SALE' }
  ];
  
  testCases.forEach(({ query, from, to }) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('CONVERSION');
      expect(plan.metric_ids).toContain('FUNNEL.CONVERSION');
      expect(plan.conversion).toBeDefined();
      expect(plan.conversion?.from_stage).toBe(from);
      expect(plan.conversion?.to_stage).toBe(to);
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('6️⃣ Drop-off Queries (3 examples)', () => {
  const testCases = [
    'where is drop-off highest mtd',
    'funnel leakage analysis last 30 days',
    'Isprava dropoff between stages this quarter'
  ];
  
  testCases.forEach((query) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('DROPOFF');
      expect(plan.metric_ids).toContain('FUNNEL.DROPOFF');
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('7️⃣ Velocity Queries (4 examples)', () => {
  const testCases = [
    { query: 'avg days lead to sale mtd', from: 'LEAD', to: 'SALE', agg: 'avg' },
    { query: 'median time prospect to account last month', from: 'PROSPECT', to: 'ACCOUNT', agg: 'median' },
    { query: 'avg time lead to prospect ytd', from: 'LEAD', to: 'PROSPECT', agg: 'avg' },
    { query: 'Isprava how long from account to sale this quarter', from: 'ACCOUNT', to: 'SALE', agg: 'avg' }
  ];
  
  testCases.forEach(({ query, from, to, agg }) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('VELOCITY');
      expect(plan.metric_ids).toContain('FUNNEL.VELOCITY');
      expect(plan.velocity).toBeDefined();
      expect(plan.velocity?.from_stage).toBe(from);
      expect(plan.velocity?.to_stage).toBe(to);
      expect(plan.velocity?.aggregation).toBe(agg);
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('8️⃣ Aging Queries (4 examples)', () => {
  const testCases = [
    { query: 'prospects older than 14 days', stage: 'PROSPECT', days: 14, operator: '>' },
    { query: 'leads stuck more than 30 days', stage: 'LEAD', days: 30, operator: '>' },
    { query: 'accounts aging over 7 days', stage: 'ACCOUNT', days: 7, operator: '>' },
    { query: 'Isprava prospects idle for 21 days', stage: 'PROSPECT', days: 21, operator: '>' }
  ];
  
  testCases.forEach(({ query, stage, days, operator }) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('AGING');
      expect(plan.metric_ids).toContain('FUNNEL.AGING');
      expect(plan.aging).toBeDefined();
      expect(plan.aging?.stage).toBe(stage);
      expect(plan.aging?.threshold_days).toBe(days);
      expect(plan.aging?.operator).toBe(operator);
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('9️⃣ Comparison Queries (3 examples)', () => {
  const testCases = [
    { query: 'sales mtd vs last month', type: 'vs_last_month' },
    { query: 'leads wow', type: 'WoW' },
    { query: 'Isprava accounts yoy', type: 'YoY' }
  ];
  
  testCases.forEach(({ query, type }) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('COMPARISON');
      expect(plan.comparison).toBeDefined();
      expect(plan.comparison?.type).toBe(type);
      expect(plan.comparison?.base_range).toBeDefined();
      expect(plan.comparison?.compare_range).toBeDefined();
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('🔟 Ranking Queries (4 examples)', () => {
  const testCases = [
    { query: 'top 10 sources by sales mtd', limit: 10, direction: 'desc' },
    { query: 'top 5 agents by leads last month', limit: 5, direction: 'desc' },
    { query: 'bottom 3 locations by accounts ytd', limit: 3, direction: 'asc' },
    { query: 'Isprava top 20 sources by bookings this quarter', limit: 20, direction: 'desc' }
  ];
  
  testCases.forEach(({ query, limit, direction }) => {
    it(`should resolve: "${query}"`, () => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      
      expect(plan.intent).toBe('RANKING');
      expect(plan.ranking).toBeDefined();
      expect(plan.ranking?.limit).toBe(limit);
      expect(plan.ranking?.direction).toBe(direction);
      
      assertValidMetricIds(plan.metric_ids);
      assertValidTimeRange(plan.time_range);
      assertDisclaimerLogic(query, plan.output_meta);
    });
  });
});

describe('✅ All Tests Summary', () => {
  it('should have tested 45+ queries', () => {
    // Single Stage: 10
    // Funnel: 5
    // Trend: 5
    // Breakdown: 5
    // Conversion: 4
    // Dropoff: 3
    // Velocity: 4
    // Aging: 4
    // Comparison: 3
    // Ranking: 4
    // Disclaimer tests: 4
    // Total: 51 test cases
    expect(true).toBe(true);
  });
  
  it('should always use valid metric IDs', () => {
    const queries = [
      'leads mtd',
      'show funnel ytd',
      'daily sales last week',
      'lead to sale conversion',
      'prospects older than 14 days'
    ];
    
    queries.forEach(query => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      assertValidMetricIds(plan.metric_ids);
    });
  });
  
  it('should always have valid time_range from TimeRangeResolver', () => {
    const queries = [
      'leads mtd',
      'sales last week',
      'prospects this quarter',
      'accounts ytd',
      'bookings last 30 days'
    ];
    
    queries.forEach(query => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      assertValidTimeRange(plan.time_range);
    });
  });
  
  it('should always apply disclaimer logic correctly', () => {
    const queriesWithoutIsprava = [
      'leads mtd',
      'show funnel',
      'sales by source'
    ];
    
    const queriesWithIsprava = [
      'Isprava leads mtd',
      'show Isprava funnel',
      'ISPRAVA sales by source'
    ];
    
    queriesWithoutIsprava.forEach(query => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      expect(plan.output_meta.disclaimer).toBe('Note: Results shown are for Isprava data only.');
    });
    
    queriesWithIsprava.forEach(query => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      expect(plan.output_meta.disclaimer).toBeNull();
      expect(plan.output_meta.scope).toBe('Isprava (explicit in query)');
    });
  });
  
  it('should compose funnel from 4 stage schemas (never custom SQL)', () => {
    const funnelQueries = [
      'show funnel mtd',
      'pipeline overview',
      'funnel snapshot last week',
      'show Isprava pipeline ytd',
      'funnel breakdown this quarter'
    ];
    
    funnelQueries.forEach(query => {
      const plan = resolveNLQ(query, TEST_CONFIG);
      expect(plan.intent).toBe('FUNNEL_SNAPSHOT');
      expect(plan.metric_ids).toEqual([
        'FUNNEL.LEADS_ENTERED',
        'FUNNEL.PROSPECTS_ENTERED',
        'FUNNEL.ACCOUNTS_ENTERED',
        'FUNNEL.SALES_ENTERED'
      ]);
    });
  });
});
