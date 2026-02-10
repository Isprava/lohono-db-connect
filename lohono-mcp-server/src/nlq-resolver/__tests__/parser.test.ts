/**
 * NLQ Resolver Test Suite
 * 
 * Comprehensive tests for NLQ → QueryPlan mappings
 * Tests all intent types, stages, time ranges, and edge cases
 */

import { describe, it, expect } from '@jest/globals';
import { resolveNLQ, tokenize, detectIntent } from '../parser.js';
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

describe('Tokenization', () => {
  it('should detect lead stage', () => {
    const tokens = tokenize('leads mtd');
    expect(tokens.stages).toContain('LEAD');
  });
  
  it('should detect multiple stages', () => {
    const tokens = tokenize('lead to prospect conversion');
    expect(tokens.stages).toContain('LEAD');
    expect(tokens.stages).toContain('PROSPECT');
  });
  
  it('should detect time expressions', () => {
    const tokens = tokenize('sales last 30 days');
    expect(tokens.time_expressions.length).toBeGreaterThan(0);
  });
  
  it('should detect dimensions', () => {
    const tokens = tokenize('sales by source');
    expect(tokens.dimensions).toContain('source');
  });
  
  it('should detect numbers', () => {
    const tokens = tokenize('top 10 sources');
    expect(tokens.numbers).toContain(10);
  });
});

describe('Intent Detection', () => {
  it('should detect FUNNEL_SNAPSHOT intent', () => {
    const tokens = tokenize('show funnel mtd');
    const intent = detectIntent('show funnel mtd', tokens);
    expect(intent).toBe('FUNNEL_SNAPSHOT');
  });
  
  it('should detect CONVERSION intent', () => {
    const tokens = tokenize('lead to prospect conversion rate');
    const intent = detectIntent('lead to prospect conversion rate', tokens);
    expect(intent).toBe('CONVERSION');
  });
  
  it('should detect VELOCITY intent', () => {
    const tokens = tokenize('avg days lead to sale');
    const intent = detectIntent('avg days lead to sale', tokens);
    expect(intent).toBe('VELOCITY');
  });
  
  it('should detect AGING intent', () => {
    const tokens = tokenize('prospects older than 14 days');
    const intent = detectIntent('prospects older than 14 days', tokens);
    expect(intent).toBe('AGING');
  });
  
  it('should detect COMPARISON intent', () => {
    const tokens = tokenize('sales mtd vs last month');
    const intent = detectIntent('sales mtd vs last month', tokens);
    expect(intent).toBe('COMPARISON');
  });
  
  it('should detect RANKING intent', () => {
    const tokens = tokenize('top 10 sources by sales');
    const intent = detectIntent('top 10 sources by sales', tokens);
    expect(intent).toBe('RANKING');
  });
});

describe('1️⃣ Single Stage Metrics', () => {
  it('should resolve: Leads MTD', () => {
    const plan = resolveNLQ('Leads MTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('STAGE_METRIC');
    expect(plan.metric_ids).toContain('FUNNEL.LEADS_ENTERED');
    expect(plan.stages).toContain('LEAD');
    expect(plan.time_range.start).toBe('2026-02-01T00:00:00+05:30');
  });
  
  it('should resolve: Sales last week', () => {
    const plan = resolveNLQ('Sales last week', TEST_CONFIG);
    
    expect(plan.intent).toBe('STAGE_METRIC');
    expect(plan.metric_ids).toContain('FUNNEL.SALES_ENTERED');
    expect(plan.stages).toContain('SALE');
    expect(plan.time_range.start).toBe('2026-02-02T00:00:00+05:30');
  });
  
  it('should resolve: Accounts in Jan 2026', () => {
    const plan = resolveNLQ('Accounts in Jan 2026', TEST_CONFIG);
    
    expect(plan.intent).toBe('STAGE_METRIC');
    expect(plan.metric_ids).toContain('FUNNEL.ACCOUNTS_ENTERED');
    expect(plan.stages).toContain('ACCOUNT');
  });
  
  it('should resolve: Prospects YTD', () => {
    const plan = resolveNLQ('Prospects YTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('STAGE_METRIC');
    expect(plan.metric_ids).toContain('FUNNEL.PROSPECTS_ENTERED');
    expect(plan.time_range.start).toBe('2026-01-01T00:00:00+05:30');
  });
  
  it('should resolve: Enquiries last 90 days', () => {
    const plan = resolveNLQ('Enquiries last 90 days', TEST_CONFIG);
    
    expect(plan.intent).toBe('STAGE_METRIC');
    expect(plan.metric_ids).toContain('FUNNEL.LEADS_ENTERED');
    expect(plan.stages).toContain('LEAD');
  });
  
  it('should resolve: Bookings this month', () => {
    const plan = resolveNLQ('Bookings this month', TEST_CONFIG);
    
    expect(plan.intent).toBe('STAGE_METRIC');
    expect(plan.metric_ids).toContain('FUNNEL.SALES_ENTERED');
    expect(plan.stages).toContain('SALE');
  });
});

describe('2️⃣ Funnel Snapshot', () => {
  it('should resolve: Show funnel MTD', () => {
    const plan = resolveNLQ('Show funnel MTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('FUNNEL_SNAPSHOT');
    expect(plan.metric_ids).toEqual([
      'FUNNEL.LEADS_ENTERED',
      'FUNNEL.PROSPECTS_ENTERED',
      'FUNNEL.ACCOUNTS_ENTERED',
      'FUNNEL.SALES_ENTERED'
    ]);
    expect(plan.stages).toEqual(['LEAD', 'PROSPECT', 'ACCOUNT', 'SALE']);
  });
  
  it('should resolve: Pipeline overview last 30 days', () => {
    const plan = resolveNLQ('Pipeline overview last 30 days', TEST_CONFIG);
    
    expect(plan.intent).toBe('FUNNEL_SNAPSHOT');
    expect(plan.metric_ids.length).toBe(4);
  });
  
  it('should resolve: Funnel snapshot this quarter', () => {
    const plan = resolveNLQ('Funnel snapshot this quarter', TEST_CONFIG);
    
    expect(plan.intent).toBe('FUNNEL_SNAPSHOT');
    expect(plan.time_range.start).toBe('2026-01-01T00:00:00+05:30');
  });
});

describe('3️⃣ Trend Queries', () => {
  it('should resolve: Daily leads last 14 days', () => {
    const plan = resolveNLQ('Daily leads last 14 days', TEST_CONFIG);
    
    expect(plan.intent).toBe('TREND');
    expect(plan.metric_ids).toContain('FUNNEL.TREND');
    expect(plan.trend_granularity).toBe('day');
    expect(plan.stages).toContain('LEAD');
  });
  
  it('should resolve: Weekly sales MTD', () => {
    const plan = resolveNLQ('Weekly sales MTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('TREND');
    expect(plan.trend_granularity).toBe('week');
    expect(plan.stages).toContain('SALE');
  });
  
  it('should resolve: Monthly prospects YTD', () => {
    const plan = resolveNLQ('Monthly prospects YTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('TREND');
    expect(plan.trend_granularity).toBe('month');
    expect(plan.stages).toContain('PROSPECT');
  });
  
  it('should resolve: Quarterly accounts trend', () => {
    const plan = resolveNLQ('Quarterly accounts trend', TEST_CONFIG);
    
    expect(plan.intent).toBe('TREND');
    expect(plan.trend_granularity).toBe('quarter');
  });
});

describe('4️⃣ Breakdown Queries', () => {
  it('should resolve: Sales by source', () => {
    const plan = resolveNLQ('Sales by source', TEST_CONFIG);
    
    expect(plan.intent).toBe('BREAKDOWN');
    expect(plan.metric_ids).toContain('FUNNEL.SALES_ENTERED');
    expect(plan.group_by).toContain('source');
  });
  
  it('should resolve: Prospects by source last month', () => {
    const plan = resolveNLQ('Prospects by source last month', TEST_CONFIG);
    
    expect(plan.intent).toBe('BREAKDOWN');
    expect(plan.group_by).toContain('source');
    expect(plan.time_range.start).toBe('2026-01-01T00:00:00+05:30');
  });
  
  it('should resolve: Leads breakdown by agent', () => {
    const plan = resolveNLQ('Leads breakdown by agent', TEST_CONFIG);
    
    expect(plan.intent).toBe('BREAKDOWN');
    expect(plan.group_by).toContain('agent');
  });
  
  it('should resolve: Sales by location MTD', () => {
    const plan = resolveNLQ('Sales by location MTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('BREAKDOWN');
    expect(plan.group_by).toContain('location');
  });
  
  it('should resolve: Accounts split by property type', () => {
    const plan = resolveNLQ('Accounts split by property type', TEST_CONFIG);
    
    expect(plan.intent).toBe('BREAKDOWN');
    expect(plan.group_by).toContain('property_type');
  });
});

describe('5️⃣ Conversion Queries', () => {
  it('should resolve: Lead to prospect conversion rate', () => {
    const plan = resolveNLQ('Lead to prospect conversion rate', TEST_CONFIG);
    
    expect(plan.intent).toBe('CONVERSION');
    expect(plan.metric_ids).toContain('FUNNEL.CONVERSION');
    expect(plan.conversion?.from_stage).toBe('LEAD');
    expect(plan.conversion?.to_stage).toBe('PROSPECT');
  });
  
  it('should resolve: Prospect to sale conversion by source', () => {
    const plan = resolveNLQ('Prospect to sale conversion by source', TEST_CONFIG);
    
    expect(plan.intent).toBe('CONVERSION');
    expect(plan.conversion?.from_stage).toBe('PROSPECT');
    expect(plan.conversion?.to_stage).toBe('SALE');
  });
  
  it('should resolve: Account to booking conversion MTD', () => {
    const plan = resolveNLQ('Account to booking conversion MTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('CONVERSION');
    expect(plan.conversion?.from_stage).toBe('ACCOUNT');
    expect(plan.conversion?.to_stage).toBe('SALE');
  });
  
  it('should resolve: Lead to account conversion last quarter', () => {
    const plan = resolveNLQ('Lead to account conversion last quarter', TEST_CONFIG);
    
    expect(plan.intent).toBe('CONVERSION');
    expect(plan.conversion?.from_stage).toBe('LEAD');
    expect(plan.conversion?.to_stage).toBe('ACCOUNT');
  });
});

describe('6️⃣ Drop-off Queries', () => {
  it('should resolve: Where is drop-off highest?', () => {
    const plan = resolveNLQ('Where is drop-off highest?', TEST_CONFIG);
    
    expect(plan.intent).toBe('DROPOFF');
    expect(plan.metric_ids).toContain('FUNNEL.DROPOFF');
  });
  
  it('should resolve: Leakage after prospects', () => {
    const plan = resolveNLQ('Leakage after prospects', TEST_CONFIG);
    
    expect(plan.intent).toBe('DROPOFF');
  });
  
  it('should resolve: Drop-off analysis MTD', () => {
    const plan = resolveNLQ('Drop-off analysis MTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('DROPOFF');
    expect(plan.time_range.start).toBe('2026-02-01T00:00:00+05:30');
  });
});

describe('7️⃣ Velocity Queries', () => {
  it('should resolve: Avg days lead to sale', () => {
    const plan = resolveNLQ('Avg days lead to sale', TEST_CONFIG);
    
    expect(plan.intent).toBe('VELOCITY');
    expect(plan.metric_ids).toContain('FUNNEL.VELOCITY');
    expect(plan.velocity?.from_stage).toBe('LEAD');
    expect(plan.velocity?.to_stage).toBe('SALE');
    expect(plan.velocity?.aggregation).toBe('avg');
  });
  
  it('should resolve: Median time prospect to account', () => {
    const plan = resolveNLQ('Median time prospect to account', TEST_CONFIG);
    
    expect(plan.intent).toBe('VELOCITY');
    expect(plan.velocity?.aggregation).toBe('median');
  });
  
  it('should resolve: How long lead to booking', () => {
    const plan = resolveNLQ('How long lead to booking', TEST_CONFIG);
    
    expect(plan.intent).toBe('VELOCITY');
    expect(plan.velocity?.from_stage).toBe('LEAD');
    expect(plan.velocity?.to_stage).toBe('SALE');
  });
  
  it('should resolve: P90 days account to sale', () => {
    const plan = resolveNLQ('P90 days account to sale', TEST_CONFIG);
    
    expect(plan.intent).toBe('VELOCITY');
    expect(plan.velocity?.aggregation).toBe('p90');
  });
});

describe('8️⃣ Aging Queries', () => {
  it('should resolve: Prospects older than 14 days', () => {
    const plan = resolveNLQ('Prospects older than 14 days', TEST_CONFIG);
    
    expect(plan.intent).toBe('AGING');
    expect(plan.metric_ids).toContain('FUNNEL.AGING');
    expect(plan.aging?.stage).toBe('PROSPECT');
    expect(plan.aging?.threshold_days).toBe(14);
    expect(plan.aging?.operator).toBe('>');
  });
  
  it('should resolve: Accounts stuck more than 30 days', () => {
    const plan = resolveNLQ('Accounts stuck more than 30 days', TEST_CONFIG);
    
    expect(plan.intent).toBe('AGING');
    expect(plan.aging?.stage).toBe('ACCOUNT');
    expect(plan.aging?.threshold_days).toBe(30);
    expect(plan.aging?.operator).toBe('>');
  });
  
  it('should resolve: Leads older than 7 days', () => {
    const plan = resolveNLQ('Leads older than 7 days', TEST_CONFIG);
    
    expect(plan.intent).toBe('AGING');
    expect(plan.aging?.stage).toBe('LEAD');
    expect(plan.aging?.threshold_days).toBe(7);
  });
  
  it('should resolve: Stale prospects 60 days', () => {
    const plan = resolveNLQ('Stale prospects 60 days', TEST_CONFIG);
    
    expect(plan.intent).toBe('AGING');
    expect(plan.aging?.threshold_days).toBe(60);
  });
});

describe('9️⃣ Comparison Queries', () => {
  it('should resolve: Sales MTD vs last month', () => {
    const plan = resolveNLQ('Sales MTD vs last month', TEST_CONFIG);
    
    expect(plan.intent).toBe('COMPARISON');
    expect(plan.metric_ids).toContain('FUNNEL.SALES_ENTERED');
    expect(plan.comparison).toBeDefined();
    expect(plan.comparison?.type).toContain('vs_last_month');
  });
  
  it('should resolve: WoW leads', () => {
    const plan = resolveNLQ('WoW leads', TEST_CONFIG);
    
    expect(plan.intent).toBe('COMPARISON');
    expect(plan.comparison?.type).toBe('WoW');
  });
  
  it('should resolve: Month over month sales', () => {
    const plan = resolveNLQ('Month over month sales', TEST_CONFIG);
    
    expect(plan.intent).toBe('COMPARISON');
    expect(plan.comparison?.type).toBe('MoM');
  });
  
  it('should resolve: YoY prospects', () => {
    const plan = resolveNLQ('YoY prospects', TEST_CONFIG);
    
    expect(plan.intent).toBe('COMPARISON');
    expect(plan.comparison?.type).toBe('YoY');
  });
  
  it('should resolve: Accounts this quarter vs last quarter', () => {
    const plan = resolveNLQ('Accounts this quarter vs last quarter', TEST_CONFIG);
    
    expect(plan.intent).toBe('COMPARISON');
    expect(plan.comparison?.type).toContain('vs_last_quarter');
  });
});

describe('🔟 Ranking Queries', () => {
  it('should resolve: Top 10 sources by sales', () => {
    const plan = resolveNLQ('Top 10 sources by sales', TEST_CONFIG);
    
    expect(plan.intent).toBe('RANKING');
    expect(plan.ranking?.limit).toBe(10);
    expect(plan.ranking?.direction).toBe('desc');
    expect(plan.group_by).toContain('source');
  });
  
  it('should resolve: Bottom 5 agents by leads', () => {
    const plan = resolveNLQ('Bottom 5 agents by leads', TEST_CONFIG);
    
    expect(plan.intent).toBe('RANKING');
    expect(plan.ranking?.limit).toBe(5);
    expect(plan.ranking?.direction).toBe('asc');
    expect(plan.group_by).toContain('agent');
  });
  
  it('should resolve: Top sources by prospects MTD', () => {
    const plan = resolveNLQ('Top sources by prospects MTD', TEST_CONFIG);
    
    expect(plan.intent).toBe('RANKING');
    expect(plan.group_by).toContain('source');
    expect(plan.time_range.start).toBe('2026-02-01T00:00:00+05:30');
  });
  
  it('should resolve: Best performing locations by sales', () => {
    const plan = resolveNLQ('Best performing locations by sales', TEST_CONFIG);
    
    expect(plan.intent).toBe('RANKING');
    expect(plan.group_by).toContain('location');
  });
});

describe('Edge Cases & Complex Queries', () => {
  it('should handle multiple dimensions', () => {
    const plan = resolveNLQ('Sales by source and agent', TEST_CONFIG);
    
    expect(plan.group_by).toContain('source');
    expect(plan.group_by).toContain('agent');
  });
  
  it('should handle FYTD (fiscal year to date)', () => {
    const plan = resolveNLQ('Leads FYTD', TEST_CONFIG);
    
    expect(plan.time_range.start).toBe('2025-04-01T00:00:00+05:30');
    expect(plan.time_range.fiscal_year_start_month).toBe(4);
  });
  
  it('should handle alternative stage terms (enquiries)', () => {
    const plan = resolveNLQ('Enquiries MTD', TEST_CONFIG);
    
    expect(plan.stages).toContain('LEAD');
    expect(plan.metric_ids).toContain('FUNNEL.LEADS_ENTERED');
  });
  
  it('should handle alternative stage terms (bookings)', () => {
    const plan = resolveNLQ('Bookings last week', TEST_CONFIG);
    
    expect(plan.stages).toContain('SALE');
    expect(plan.metric_ids).toContain('FUNNEL.SALES_ENTERED');
  });
  
  it('should handle alternative stage terms (maal laao)', () => {
    const plan = resolveNLQ('maal laao MTD', TEST_CONFIG);
    
    expect(plan.stages).toContain('SALE');
  });
  
  it('should default to MTD when no time specified', () => {
    const plan = resolveNLQ('Sales', TEST_CONFIG);
    
    expect(plan.time_range.start).toBe('2026-02-01T00:00:00+05:30');
  });
  
  it('should handle confidence scoring', () => {
    const plan = resolveNLQ('Leads MTD by source', TEST_CONFIG);
    
    expect(plan.confidence).toBeGreaterThan(0.5);
    expect(plan.confidence).toBeLessThanOrEqual(1.0);
  });
  
  it('should preserve original query', () => {
    const query = 'Top 10 sources by sales MTD';
    const plan = resolveNLQ(query, TEST_CONFIG);
    
    expect(plan.original_query).toBe(query);
  });
});

describe('Time Range Integration', () => {
  it('should integrate with WTD', () => {
    const plan = resolveNLQ('Leads WTD', TEST_CONFIG);
    
    expect(plan.time_range.start).toBe('2026-02-09T00:00:00+05:30');
    expect(plan.time_range.end).toBe('2026-02-09T12:00:00+05:30');
  });
  
  it('should integrate with QTD', () => {
    const plan = resolveNLQ('Sales QTD', TEST_CONFIG);
    
    expect(plan.time_range.start).toBe('2026-01-01T00:00:00+05:30');
  });
  
  it('should integrate with rolling windows', () => {
    const plan = resolveNLQ('Prospects last 60 days', TEST_CONFIG);
    
    expect(plan.time_range.mode).toBe('rolling');
  });
  
  it('should integrate with calendar periods', () => {
    const plan = resolveNLQ('Accounts this month', TEST_CONFIG);
    
    expect(plan.time_range.mode).toBe('calendar');
  });
});

describe('QueryPlan Completeness', () => {
  it('should include all required fields', () => {
    const plan = resolveNLQ('Leads MTD', TEST_CONFIG);
    
    expect(plan).toHaveProperty('intent');
    expect(plan).toHaveProperty('metric_ids');
    expect(plan).toHaveProperty('stages');
    expect(plan).toHaveProperty('time_range');
    expect(plan).toHaveProperty('original_query');
    expect(plan).toHaveProperty('confidence');
  });
  
  it('should reference metric registry', () => {
    const plan = resolveNLQ('Funnel MTD', TEST_CONFIG);
    
    // All metric IDs should follow FUNNEL.* pattern
    plan.metric_ids.forEach(id => {
      expect(id).toMatch(/^FUNNEL\./);
    });
  });
  
  it('should reference time range resolver', () => {
    const plan = resolveNLQ('Sales last 30 days', TEST_CONFIG);
    
    // Time range should have all required fields from TimeRangeResolver
    expect(plan.time_range).toHaveProperty('start');
    expect(plan.time_range).toHaveProperty('end');
    expect(plan.time_range).toHaveProperty('timezone');
    expect(plan.time_range).toHaveProperty('mode');
  });
});
