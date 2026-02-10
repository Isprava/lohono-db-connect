/**
 * Time Range Parser Test Suite
 * 
 * Comprehensive golden tests using fixed reference date: 2026-02-09T12:00:00+05:30
 * Tests all supported NLQ expressions with edge cases
 */

import { describe, it, expect } from '@jest/globals';
import { resolveTimeRange, normalize, detectTimeTerms } from '../parser.js';
import { TimeRangeConfig } from '../types.js';

// Golden reference date: Monday, February 9, 2026 at 12:00 PM IST
const REFERENCE_DATE = '2026-02-09T12:00:00+05:30';

// Default test configuration
const TEST_CONFIG: TimeRangeConfig = {
  timezone: 'Asia/Kolkata',
  fiscal_config: {
    fiscal_year_start_month: 4, // April
    fiscal_year_label: 'FY'
  },
  week_start: 'monday',
  now: REFERENCE_DATE
};

describe('normalize', () => {
  it('should convert to lowercase', () => {
    expect(normalize('MTD')).toBe('month to date');
    expect(normalize('YTD')).toBe('year to date');
  });
  
  it('should expand abbreviations', () => {
    expect(normalize('WTD')).toBe('week to date');
    expect(normalize('L7D')).toBe('last 7 days');
    expect(normalize('L30D')).toBe('last 30 days');
    expect(normalize('WoW')).toBe('week over week');
    expect(normalize('YoY')).toBe('year over year');
  });
  
  it('should normalize synonyms', () => {
    expect(normalize('current month')).toBe('this month');
    expect(normalize('previous week')).toBe('last week');
    expect(normalize('prior quarter')).toBe('last quarter');
    expect(normalize('trailing 30 days')).toBe('last 30 days');
  });
  
  it('should handle hyphenated terms', () => {
    expect(normalize('week-to-date')).toBe('week to date');
    expect(normalize('year-over-year')).toBe('year over year');
  });
});

describe('detectTimeTerms', () => {
  it('should detect to-date terms', () => {
    const terms = detectTimeTerms('month to date');
    expect(terms).toHaveLength(1);
    expect(terms[0].type).toBe('to_date');
    expect(terms[0].confidence).toBe(1.0);
  });
  
  it('should detect calendar terms', () => {
    const terms = detectTimeTerms('last month');
    expect(terms).toHaveLength(1);
    expect(terms[0].type).toBe('calendar');
  });
  
  it('should detect rolling window terms', () => {
    const terms = detectTimeTerms('last 7 days');
    expect(terms).toHaveLength(1);
    expect(terms[0].type).toBe('rolling');
  });
  
  it('should detect comparison terms', () => {
    const terms = detectTimeTerms('year over year');
    expect(terms).toHaveLength(1);
    expect(terms[0].type).toBe('comparison');
  });
  
  it('should handle overlapping terms', () => {
    const terms = detectTimeTerms('show me last month data');
    expect(terms.length).toBeGreaterThan(0);
  });
});

describe('To-Date Expressions', () => {
  describe('WTD (Week to Date)', () => {
    it('should return current week from Monday to now', () => {
      const result = resolveTimeRange('WTD', TEST_CONFIG);
      
      expect(result.mode).toBe('to_date');
      expect(result.granularity).toBe('week');
      expect(result.start).toBe('2026-02-09T00:00:00+05:30'); // Monday start
      expect(result.end).toBe('2026-02-09T12:00:00+05:30'); // Now
      expect(result.timezone).toBe('Asia/Kolkata');
    });
    
    it('should handle mid-week correctly', () => {
      const midWeekConfig = { ...TEST_CONFIG, now: '2026-02-11T15:30:00+05:30' }; // Wednesday
      const result = resolveTimeRange('week to date', midWeekConfig);
      
      expect(result.start).toBe('2026-02-09T00:00:00+05:30'); // Still Monday
      expect(result.end).toBe('2026-02-11T15:30:00+05:30');
    });
  });
  
  describe('MTD (Month to Date)', () => {
    it('should return current month from 1st to now', () => {
      const result = resolveTimeRange('MTD', TEST_CONFIG);
      
      expect(result.mode).toBe('to_date');
      expect(result.granularity).toBe('month');
      expect(result.start).toBe('2026-02-01T00:00:00+05:30');
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
    
    it('should handle end of month correctly (Jan 31)', () => {
      const endMonthConfig = { ...TEST_CONFIG, now: '2026-01-31T23:59:59+05:30' };
      const result = resolveTimeRange('month to date', endMonthConfig);
      
      expect(result.start).toBe('2026-01-01T00:00:00+05:30');
      expect(result.end).toBe('2026-01-31T23:59:59+05:30');
    });
  });
  
  describe('QTD (Quarter to Date)', () => {
    it('should return current quarter (Q1: Jan-Mar)', () => {
      const result = resolveTimeRange('QTD', TEST_CONFIG);
      
      expect(result.mode).toBe('to_date');
      expect(result.granularity).toBe('quarter');
      expect(result.start).toBe('2026-01-01T00:00:00+05:30'); // Q1 starts Jan 1
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
    
    it('should handle Q2 correctly', () => {
      const q2Config = { ...TEST_CONFIG, now: '2026-05-15T10:00:00+05:30' }; // May
      const result = resolveTimeRange('quarter to date', q2Config);
      
      expect(result.start).toBe('2026-04-01T00:00:00+05:30'); // Q2 starts Apr 1
    });
  });
  
  describe('YTD (Year to Date)', () => {
    it('should return current year from Jan 1 to now', () => {
      const result = resolveTimeRange('YTD', TEST_CONFIG);
      
      expect(result.mode).toBe('to_date');
      expect(result.granularity).toBe('year');
      expect(result.start).toBe('2026-01-01T00:00:00+05:30');
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
    
    it('should handle leap year correctly', () => {
      const leapYearConfig = { ...TEST_CONFIG, now: '2024-02-29T12:00:00+05:30' };
      const result = resolveTimeRange('year to date', leapYearConfig);
      
      expect(result.start).toBe('2024-01-01T00:00:00+05:30');
      expect(result.end).toBe('2024-02-29T12:00:00+05:30');
    });
  });
  
  describe('FYTD (Fiscal Year to Date)', () => {
    it('should return fiscal year from Apr 1 to now', () => {
      const result = resolveTimeRange('FYTD', TEST_CONFIG);
      
      expect(result.mode).toBe('to_date');
      expect(result.granularity).toBe('year');
      expect(result.start).toBe('2025-04-01T00:00:00+05:30'); // FY2025-26 started Apr 1, 2025
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
      expect(result.fiscal_year_start_month).toBe(4);
    });
    
    it('should handle fiscal year crossing correctly', () => {
      const crossingConfig = { ...TEST_CONFIG, now: '2026-03-31T23:59:59+05:30' }; // Last day of FY
      const result = resolveTimeRange('fiscal year to date', crossingConfig);
      
      expect(result.start).toBe('2025-04-01T00:00:00+05:30');
      expect(result.end).toBe('2026-03-31T23:59:59+05:30');
    });
  });
});

describe('Calendar-Aligned Expressions', () => {
  describe('This Week/Month/Quarter/Year', () => {
    it('should return this week (full week)', () => {
      const result = resolveTimeRange('this week', TEST_CONFIG);
      
      expect(result.mode).toBe('calendar');
      expect(result.granularity).toBe('week');
      expect(result.start).toBe('2026-02-09T00:00:00+05:30'); // Monday
      expect(result.end).toBe('2026-02-16T00:00:00+05:30'); // Next Monday
    });
    
    it('should return this month (full month)', () => {
      const result = resolveTimeRange('this month', TEST_CONFIG);
      
      expect(result.mode).toBe('calendar');
      expect(result.granularity).toBe('month');
      expect(result.start).toBe('2026-02-01T00:00:00+05:30');
      expect(result.end).toBe('2026-03-01T00:00:00+05:30');
    });
    
    it('should return this quarter', () => {
      const result = resolveTimeRange('this quarter', TEST_CONFIG);
      
      expect(result.granularity).toBe('quarter');
      expect(result.start).toBe('2026-01-01T00:00:00+05:30');
      expect(result.end).toBe('2026-04-01T00:00:00+05:30');
    });
    
    it('should return this year', () => {
      const result = resolveTimeRange('this year', TEST_CONFIG);
      
      expect(result.granularity).toBe('year');
      expect(result.start).toBe('2026-01-01T00:00:00+05:30');
      expect(result.end).toBe('2027-01-01T00:00:00+05:30');
    });
  });
  
  describe('Last Week/Month/Quarter/Year', () => {
    it('should return last week', () => {
      const result = resolveTimeRange('last week', TEST_CONFIG);
      
      expect(result.mode).toBe('calendar');
      expect(result.granularity).toBe('week');
      // Last week: Feb 2-8, 2026 (Mon-Sun)
      expect(result.start).toBe('2026-02-02T00:00:00+05:30');
      expect(result.end).toBe('2026-02-09T00:00:00+05:30');
    });
    
    it('should return last month', () => {
      const result = resolveTimeRange('last month', TEST_CONFIG);
      
      expect(result.granularity).toBe('month');
      expect(result.start).toBe('2026-01-01T00:00:00+05:30'); // January
      expect(result.end).toBe('2026-02-01T00:00:00+05:30');
    });
    
    it('should return last quarter', () => {
      const result = resolveTimeRange('last quarter', TEST_CONFIG);
      
      expect(result.granularity).toBe('quarter');
      expect(result.start).toBe('2025-10-01T00:00:00+05:30'); // Q4 2025
      expect(result.end).toBe('2026-01-01T00:00:00+05:30');
    });
    
    it('should return last year', () => {
      const result = resolveTimeRange('last year', TEST_CONFIG);
      
      expect(result.granularity).toBe('year');
      expect(result.start).toBe('2025-01-01T00:00:00+05:30');
      expect(result.end).toBe('2026-01-01T00:00:00+05:30');
    });
  });
  
  describe('Next Week/Month/Quarter/Year', () => {
    it('should return next week', () => {
      const result = resolveTimeRange('next week', TEST_CONFIG);
      
      expect(result.mode).toBe('calendar');
      expect(result.granularity).toBe('week');
      expect(result.start).toBe('2026-02-16T00:00:00+05:30');
      expect(result.end).toBe('2026-02-23T00:00:00+05:30');
    });
    
    it('should return next month', () => {
      const result = resolveTimeRange('next month', TEST_CONFIG);
      
      expect(result.granularity).toBe('month');
      expect(result.start).toBe('2026-03-01T00:00:00+05:30'); // March
      expect(result.end).toBe('2026-04-01T00:00:00+05:30');
    });
  });
});

describe('Rolling Window Expressions', () => {
  describe('Last N Days', () => {
    it('should return last 7 days', () => {
      const result = resolveTimeRange('last 7 days', TEST_CONFIG);
      
      expect(result.mode).toBe('rolling');
      expect(result.granularity).toBe('day');
      expect(result.start).toBe('2026-02-02T12:00:00+05:30'); // 7 days before
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
    
    it('should return last 30 days', () => {
      const result = resolveTimeRange('L30D', TEST_CONFIG);
      
      expect(result.mode).toBe('rolling');
      expect(result.start).toBe('2026-01-10T12:00:00+05:30');
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
    
    it('should return last 90 days', () => {
      const result = resolveTimeRange('past 90 days', TEST_CONFIG);
      
      expect(result.mode).toBe('rolling');
      expect(result.start).toBe('2025-11-11T12:00:00+05:30');
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
  });
  
  describe('Last N Weeks', () => {
    it('should return last 4 weeks', () => {
      const result = resolveTimeRange('last 4 weeks', TEST_CONFIG);
      
      expect(result.mode).toBe('rolling');
      expect(result.granularity).toBe('week');
      expect(result.start).toBe('2026-01-12T12:00:00+05:30');
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
  });
  
  describe('Last N Months', () => {
    it('should return last 3 months', () => {
      const result = resolveTimeRange('last 3 months', TEST_CONFIG);
      
      expect(result.mode).toBe('rolling');
      expect(result.granularity).toBe('month');
      expect(result.start).toBe('2025-11-09T12:00:00+05:30');
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
    
    it('should return last 12 months', () => {
      const result = resolveTimeRange('L12M', TEST_CONFIG);
      
      expect(result.mode).toBe('rolling');
      expect(result.start).toBe('2025-02-09T12:00:00+05:30');
      expect(result.end).toBe('2026-02-09T12:00:00+05:30');
    });
  });
});

describe('Explicit Date Range Expressions', () => {
  it('should parse between dates', () => {
    const result = resolveTimeRange('between 2026-01-01 and 2026-01-31', TEST_CONFIG);
    
    expect(result.mode).toBe('explicit');
    expect(result.start).toContain('2026-01-01');
    expect(result.end).toContain('2026-01-31');
  });
  
  it('should parse from-to dates', () => {
    const result = resolveTimeRange('from 2026-02-01 to 2026-02-28', TEST_CONFIG);
    
    expect(result.mode).toBe('explicit');
    expect(result.start).toContain('2026-02-01');
    expect(result.end).toContain('2026-02-28');
  });
  
  it('should handle month names', () => {
    const result = resolveTimeRange('between Jan 1 and Jan 31', TEST_CONFIG);
    
    expect(result.mode).toBe('explicit');
    expect(result.start).toContain('2026-01-01');
    expect(result.end).toContain('2026-01-31');
  });
});

describe('Open-Ended Expressions', () => {
  describe('Since/After', () => {
    it('should parse since date', () => {
      const result = resolveTimeRange('since 2026-01-01', TEST_CONFIG);
      
      expect(result.mode).toBe('since');
      expect(result.start).toContain('2026-01-01');
      expect(result.end).toBeNull();
    });
    
    it('should parse after date', () => {
      const result = resolveTimeRange('after yesterday', TEST_CONFIG);
      
      expect(result.mode).toBe('since');
      expect(result.start).toContain('2026-02-08');
      expect(result.end).toBeNull();
    });
  });
  
  describe('Until/Before', () => {
    it('should parse until date', () => {
      const result = resolveTimeRange('until 2026-12-31', TEST_CONFIG);
      
      expect(result.mode).toBe('until');
      expect(result.start).toBeNull();
      expect(result.end).toContain('2026-12-31');
    });
    
    it('should parse before date', () => {
      const result = resolveTimeRange('before tomorrow', TEST_CONFIG);
      
      expect(result.mode).toBe('until');
      expect(result.start).toBeNull();
      expect(result.end).toContain('2026-02-10');
    });
  });
});

describe('Comparison Expressions', () => {
  describe('DoD (Day over Day)', () => {
    it('should return current day and previous day', () => {
      const result = resolveTimeRange('DoD', TEST_CONFIG);
      
      expect(result.mode).toBe('comparison');
      expect(result.granularity).toBe('day');
      expect(result.comparison).toBeDefined();
      expect(result.comparison?.type).toBe('DoD');
      
      // Base range: today
      expect(result.comparison?.base_range.start).toBe('2026-02-09T00:00:00+05:30');
      expect(result.comparison?.base_range.end).toBe('2026-02-10T00:00:00+05:30');
      
      // Compare range: yesterday
      expect(result.comparison?.compare_range.start).toBe('2026-02-08T00:00:00+05:30');
      expect(result.comparison?.compare_range.end).toBe('2026-02-09T00:00:00+05:30');
    });
  });
  
  describe('WoW (Week over Week)', () => {
    it('should return current week and previous week', () => {
      const result = resolveTimeRange('WoW', TEST_CONFIG);
      
      expect(result.mode).toBe('comparison');
      expect(result.granularity).toBe('week');
      expect(result.comparison?.type).toBe('WoW');
      
      // Base range: this week
      expect(result.comparison?.base_range.start).toBe('2026-02-09T00:00:00+05:30');
      expect(result.comparison?.base_range.end).toBe('2026-02-16T00:00:00+05:30');
      
      // Compare range: last week
      expect(result.comparison?.compare_range.start).toBe('2026-02-02T00:00:00+05:30');
      expect(result.comparison?.compare_range.end).toBe('2026-02-09T00:00:00+05:30');
    });
  });
  
  describe('MoM (Month over Month)', () => {
    it('should return current month and previous month', () => {
      const result = resolveTimeRange('MoM', TEST_CONFIG);
      
      expect(result.mode).toBe('comparison');
      expect(result.granularity).toBe('month');
      expect(result.comparison?.type).toBe('MoM');
      
      // Base range: February
      expect(result.comparison?.base_range.start).toBe('2026-02-01T00:00:00+05:30');
      expect(result.comparison?.base_range.end).toBe('2026-03-01T00:00:00+05:30');
      
      // Compare range: January
      expect(result.comparison?.compare_range.start).toBe('2026-01-01T00:00:00+05:30');
      expect(result.comparison?.compare_range.end).toBe('2026-02-01T00:00:00+05:30');
    });
  });
  
  describe('QoQ (Quarter over Quarter)', () => {
    it('should return current quarter and previous quarter', () => {
      const result = resolveTimeRange('QoQ', TEST_CONFIG);
      
      expect(result.mode).toBe('comparison');
      expect(result.granularity).toBe('quarter');
      expect(result.comparison?.type).toBe('QoQ');
      
      // Base range: Q1 2026
      expect(result.comparison?.base_range.start).toBe('2026-01-01T00:00:00+05:30');
      expect(result.comparison?.base_range.end).toBe('2026-04-01T00:00:00+05:30');
      
      // Compare range: Q4 2025
      expect(result.comparison?.compare_range.start).toBe('2025-10-01T00:00:00+05:30');
      expect(result.comparison?.compare_range.end).toBe('2026-01-01T00:00:00+05:30');
    });
  });
  
  describe('YoY (Year over Year)', () => {
    it('should return current year and previous year', () => {
      const result = resolveTimeRange('YoY', TEST_CONFIG);
      
      expect(result.mode).toBe('comparison');
      expect(result.granularity).toBe('year');
      expect(result.comparison?.type).toBe('YoY');
      
      // Base range: 2026
      expect(result.comparison?.base_range.start).toBe('2026-01-01T00:00:00+05:30');
      expect(result.comparison?.base_range.end).toBe('2027-01-01T00:00:00+05:30');
      
      // Compare range: 2025
      expect(result.comparison?.compare_range.start).toBe('2025-01-01T00:00:00+05:30');
      expect(result.comparison?.compare_range.end).toBe('2026-01-01T00:00:00+05:30');
    });
  });
  
  describe('SPLY (Same Period Last Year)', () => {
    it('should return same period last year', () => {
      const result = resolveTimeRange('SPLY', TEST_CONFIG);
      
      expect(result.mode).toBe('comparison');
      expect(result.comparison?.type).toBe('SPLY');
    });
  });
});

describe('Edge Cases', () => {
  it('should handle month boundary (Jan 31)', () => {
    const janConfig = { ...TEST_CONFIG, now: '2026-01-31T12:00:00+05:30' };
    const result = resolveTimeRange('MTD', janConfig);
    
    expect(result.start).toBe('2026-01-01T00:00:00+05:30');
    expect(result.end).toBe('2026-01-31T12:00:00+05:30');
  });
  
  it('should handle leap year (Feb 29)', () => {
    const leapConfig = { ...TEST_CONFIG, now: '2024-02-29T12:00:00+05:30' };
    const result = resolveTimeRange('this month', leapConfig);
    
    expect(result.start).toBe('2024-02-01T00:00:00+05:30');
    expect(result.end).toBe('2024-03-01T00:00:00+05:30');
  });
  
  it('should handle week start on Monday', () => {
    const result = resolveTimeRange('this week', TEST_CONFIG);
    
    expect(result.calendar_week_start).toBe('monday');
    expect(result.start).toBe('2026-02-09T00:00:00+05:30'); // Monday
  });
  
  it('should handle fiscal year crossing', () => {
    const marchConfig = { ...TEST_CONFIG, now: '2026-03-15T12:00:00+05:30' };
    const result = resolveTimeRange('FYTD', marchConfig);
    
    expect(result.start).toBe('2025-04-01T00:00:00+05:30'); // FY started Apr 1, 2025
  });
  
  it('should handle Sunday in week calculation', () => {
    const sundayConfig = { ...TEST_CONFIG, now: '2026-02-08T12:00:00+05:30' }; // Sunday
    const result = resolveTimeRange('this week', sundayConfig);
    
    // Week starts Monday, so Sunday is still part of Feb 2-8 week
    expect(result.start).toBe('2026-02-02T00:00:00+05:30');
  });
  
  it('should handle timezone correctly', () => {
    const result = resolveTimeRange('today', TEST_CONFIG);
    
    expect(result.timezone).toBe('Asia/Kolkata');
    expect(result.start).toContain('+05:30');
    expect(result.end).toContain('+05:30');
  });
});

describe('SQL Integration', () => {
  it('should provide exclusive end boundary for SQL WHERE clauses', () => {
    const result = resolveTimeRange('this month', TEST_CONFIG);
    
    // End should be exclusive (start of next period)
    expect(result.end).toBe('2026-03-01T00:00:00+05:30');
    
    // This allows SQL: WHERE timestamp >= start AND timestamp < end
  });
  
  it('should provide ISO 8601 formatted dates', () => {
    const result = resolveTimeRange('last week', TEST_CONFIG);
    
    // Check ISO 8601 format: YYYY-MM-DDTHH:MM:SS±HH:MM
    expect(result.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(result.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});
