/**
 * NLQ Parser for Time Range Interpretation
 * 
 * Provides deterministic parsing of natural language time expressions
 * into canonical TimeRange objects.
 */

import {
  TimeRange,
  TimeRangeConfig,
  DetectedTimeTerm,
  TimeRangeMode,
  ComparisonType,
  DEFAULT_TIME_RANGE_CONFIG,
  ABBREVIATIONS,
  MONTH_NAMES,
  NLQ_VOCABULARY
} from './types.js';
import * as utils from './utils.js';

/**
 * Normalize input text for parsing
 * - Convert to lowercase
 * - Expand abbreviations
 * - Normalize whitespace and punctuation
 * - Handle common synonyms
 */
export function normalize(text: string): string {
  let normalized = text.toLowerCase().trim();
  
  // Replace multiple spaces with single space
  normalized = normalized.replace(/\s+/g, ' ');
  
  // Expand abbreviations
  for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
    const abbrLower = abbr.toLowerCase();
    // Match whole word boundaries
    const regex = new RegExp(`\\b${abbrLower}\\b`, 'gi');
    normalized = normalized.replace(regex, full);
  }
  
  // Normalize hyphenated terms
  normalized = normalized.replace(/-to-/g, ' to ');
  normalized = normalized.replace(/(\w)-(\w)/g, '$1 $2');
  
  // Normalize comparison terms
  normalized = normalized.replace(/\bvs\b/g, 'versus');
  normalized = normalized.replace(/\bcompared to\b/g, 'versus');
  
  // Normalize period keywords
  normalized = normalized.replace(/\bcurrent\b/g, 'this');
  normalized = normalized.replace(/\bprevious\b/g, 'last');
  normalized = normalized.replace(/\bprior\b/g, 'last');
  normalized = normalized.replace(/\btrailing\b/g, 'last');
  normalized = normalized.replace(/\bpast\b/g, 'last');
  
  return normalized;
}

/**
 * Detect time terms in normalized text
 * Returns array of detected terms with positions and confidence scores
 */
export function detectTimeTerms(text: string): DetectedTimeTerm[] {
  const normalized = normalize(text);
  const terms: DetectedTimeTerm[] = [];
  
  // Pattern matching for various time expressions
  
  // 1. To-date patterns (WTD, MTD, QTD, YTD, FYTD, PTD)
  const toDatePattern = /\b(week|month|quarter|year|fiscal year|period)\s+to\s+date\b/g;
  let match;
  while ((match = toDatePattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'to_date',
      confidence: 1.0,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  // 2. Calendar-aligned patterns (this/last/next + period)
  const calendarPattern = /\b(this|last|next)\s+(week|month|quarter|year)\b/g;
  while ((match = calendarPattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'calendar',
      confidence: 1.0,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  // 3. Rolling window patterns (last N days/weeks/months)
  const rollingPattern = /\b(last|past)\s+(\d+)\s+(day|week|month|quarter|year)s?\b/g;
  while ((match = rollingPattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'rolling',
      confidence: 1.0,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  // 4. Explicit range patterns (between X and Y, from X to Y)
  const betweenPattern = /\bbetween\s+(.+?)\s+and\s+(.+?)\b/g;
  while ((match = betweenPattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'explicit',
      confidence: 0.9,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  const fromToPattern = /\bfrom\s+(.+?)\s+to\s+(.+?)\b/g;
  while ((match = fromToPattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'explicit',
      confidence: 0.9,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  // 5. Open-ended patterns (since/until/before/after X)
  const sincePattern = /\b(since|after)\s+(.+?)\b/g;
  while ((match = sincePattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'since',
      confidence: 0.8,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  const untilPattern = /\b(until|before|up to)\s+(.+?)\b/g;
  while ((match = untilPattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'until',
      confidence: 0.8,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  // 6. Comparison patterns (DoD, WoW, MoM, QoQ, YoY, SPLY)
  const comparisonPattern = /\b(day|week|month|quarter|year)\s+over\s+(day|week|month|quarter|year)\b/g;
  while ((match = comparisonPattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'comparison',
      confidence: 1.0,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  const splyPattern = /\bsame\s+period\s+last\s+(week|month|quarter|year)\b/g;
  while ((match = splyPattern.exec(normalized)) !== null) {
    terms.push({
      token: match[0],
      type: 'comparison',
      confidence: 1.0,
      start_pos: match.index,
      end_pos: match.index + match[0].length
    });
  }
  
  // Sort by position and filter overlapping terms (keep highest confidence)
  terms.sort((a, b) => a.start_pos - b.start_pos);
  
  const filtered: DetectedTimeTerm[] = [];
  for (const term of terms) {
    const overlaps = filtered.some(t => 
      (term.start_pos >= t.start_pos && term.start_pos < t.end_pos) ||
      (term.end_pos > t.start_pos && term.end_pos <= t.end_pos)
    );
    if (!overlaps) {
      filtered.push(term);
    }
  }
  
  return filtered;
}

/**
 * Resolve time range from detected terms and configuration
 */
export function resolveTimeRange(
  text: string,
  config: Partial<TimeRangeConfig> = {}
): TimeRange {
  const fullConfig: TimeRangeConfig = {
    ...DEFAULT_TIME_RANGE_CONFIG,
    ...config
  };
  
  const now = fullConfig.now ? new Date(fullConfig.now) : new Date();
  const timezone = fullConfig.timezone;
  const weekStart = fullConfig.week_start;
  const fiscalConfig = fullConfig.fiscal_config;
  
  const normalized = normalize(text);
  const terms = detectTimeTerms(text);
  
  // If no terms detected, try to parse as explicit date
  if (terms.length === 0) {
    return parseExplicitDate(text, now, timezone);
  }
  
  // Use the first (highest confidence) term
  const primaryTerm = terms[0];
  
  // Resolve based on term type
  switch (primaryTerm.type) {
    case 'to_date':
      return resolveToDate(normalized, now, timezone, weekStart, fiscalConfig);
    
    case 'calendar':
      return resolveCalendar(normalized, now, timezone, weekStart, fiscalConfig);
    
    case 'rolling':
      return resolveRolling(normalized, now, timezone);
    
    case 'explicit':
      return resolveExplicit(normalized, now, timezone);
    
    case 'since':
      return resolveSince(normalized, now, timezone);
    
    case 'until':
      return resolveUntil(normalized, now, timezone);
    
    case 'comparison':
      return resolveComparison(normalized, now, timezone, weekStart, fiscalConfig);
    
    default:
      throw new Error(`Unsupported term type: ${primaryTerm.type}`);
  }
}

/**
 * Resolve to-date expressions (WTD, MTD, QTD, YTD, FYTD, PTD)
 */
function resolveToDate(
  text: string,
  now: Date,
  timezone: string,
  weekStart: string,
  fiscalConfig: any
): TimeRange {
  let granularity: 'week' | 'month' | 'quarter' | 'year' = 'day' as any;
  let start: Date;
  
  if (text.includes('week')) {
    granularity = 'week';
    start = utils.startOfWeek(now, timezone, weekStart as any);
  } else if (text.includes('month')) {
    granularity = 'month';
    start = utils.startOfMonth(now, timezone);
  } else if (text.includes('quarter')) {
    granularity = 'quarter';
    start = utils.startOfQuarter(now, timezone);
  } else if (text.includes('fiscal year')) {
    granularity = 'year';
    start = utils.startOfFiscalYear(now, timezone, fiscalConfig);
  } else if (text.includes('year')) {
    granularity = 'year';
    start = utils.startOfYear(now, timezone);
  } else {
    throw new Error(`Unable to determine granularity from: ${text}`);
  }
  
  return {
    mode: 'to_date',
    start: utils.formatDate(start, timezone),
    end: utils.formatDate(now, timezone),
    timezone,
    granularity,
    calendar_week_start: weekStart as any,
    fiscal_year_start_month: fiscalConfig.fiscal_year_start_month,
    original_text: text
  };
}

/**
 * Resolve calendar-aligned expressions (this/last/next week/month/quarter/year)
 */
function resolveCalendar(
  text: string,
  now: Date,
  timezone: string,
  weekStart: string,
  fiscalConfig: any
): TimeRange {
  let granularity: 'week' | 'month' | 'quarter' | 'year' = 'day' as any;
  let offset = 0;
  
  // Determine offset
  if (text.includes('last')) {
    offset = -1;
  } else if (text.includes('next')) {
    offset = 1;
  } else if (text.includes('this')) {
    offset = 0;
  }
  
  // Determine granularity
  if (text.includes('week')) {
    granularity = 'week';
  } else if (text.includes('month')) {
    granularity = 'month';
  } else if (text.includes('quarter')) {
    granularity = 'quarter';
  } else if (text.includes('year')) {
    granularity = 'year';
  }
  
  // Calculate start and end
  const baseDate = offset !== 0 
    ? utils.subtractUnit(now, granularity, timezone, { weekStart: weekStart as any, fiscalConfig })
    : now;
  
  const periodDate = offset < 0 ? utils.addDays(baseDate, offset * 7) : baseDate;
  
  const start = utils.startOfPeriod(periodDate, granularity, timezone, { 
    weekStart: weekStart as any, 
    fiscalConfig 
  });
  const end = utils.endOfPeriod(periodDate, granularity, timezone, { 
    weekStart: weekStart as any, 
    fiscalConfig 
  });
  
  return {
    mode: 'calendar',
    start: utils.formatDate(start, timezone),
    end: utils.formatDate(end, timezone),
    timezone,
    granularity,
    calendar_week_start: weekStart as any,
    fiscal_year_start_month: fiscalConfig.fiscal_year_start_month,
    original_text: text
  };
}

/**
 * Resolve rolling window expressions (last N days/weeks/months)
 */
function resolveRolling(
  text: string,
  now: Date,
  timezone: string
): TimeRange {
  // Extract number
  const match = text.match(/(\d+)\s+(day|week|month|quarter|year)s?/);
  if (!match) {
    throw new Error(`Unable to parse rolling window from: ${text}`);
  }
  
  const count = parseInt(match[1], 10);
  const unit = match[2] as 'day' | 'week' | 'month' | 'quarter' | 'year';
  
  // Calculate start date
  let start: Date;
  switch (unit) {
    case 'day':
      start = utils.addDays(now, -count);
      break;
    case 'week':
      start = utils.addWeeks(now, -count);
      break;
    case 'month':
      start = utils.addMonths(now, -count, timezone);
      break;
    case 'quarter':
      start = utils.addQuarters(now, -count, timezone);
      break;
    case 'year':
      start = utils.addYears(now, -count, timezone);
      break;
  }
  
  return {
    mode: 'rolling',
    start: utils.formatDate(start, timezone),
    end: utils.formatDate(now, timezone),
    timezone,
    granularity: unit,
    calendar_week_start: 'monday',
    fiscal_year_start_month: 4,
    original_text: text
  };
}

/**
 * Resolve explicit date range expressions (between X and Y, from X to Y)
 */
function resolveExplicit(
  text: string,
  now: Date,
  timezone: string
): TimeRange {
  // Try to extract dates from text
  const betweenMatch = text.match(/between\s+(.+?)\s+and\s+(.+)/);
  const fromToMatch = text.match(/from\s+(.+?)\s+to\s+(.+)/);
  
  let startStr: string, endStr: string;
  
  if (betweenMatch) {
    startStr = betweenMatch[1].trim();
    endStr = betweenMatch[2].trim();
  } else if (fromToMatch) {
    startStr = fromToMatch[1].trim();
    endStr = fromToMatch[2].trim();
  } else {
    throw new Error(`Unable to parse explicit range from: ${text}`);
  }
  
  const start = parseRelativeOrAbsoluteDate(startStr, now, timezone);
  const end = parseRelativeOrAbsoluteDate(endStr, now, timezone);
  
  return {
    mode: 'explicit',
    start: utils.formatDate(start, timezone),
    end: utils.formatDate(end, timezone),
    timezone,
    granularity: 'day',
    calendar_week_start: 'monday',
    fiscal_year_start_month: 4,
    original_text: text
  };
}

/**
 * Resolve since/after expressions
 */
function resolveSince(
  text: string,
  now: Date,
  timezone: string
): TimeRange {
  const match = text.match(/(?:since|after)\s+(.+)/);
  if (!match) {
    throw new Error(`Unable to parse since expression from: ${text}`);
  }
  
  const dateStr = match[1].trim();
  const start = parseRelativeOrAbsoluteDate(dateStr, now, timezone);
  
  return {
    mode: 'since',
    start: utils.formatDate(start, timezone),
    end: null,
    timezone,
    granularity: 'day',
    calendar_week_start: 'monday',
    fiscal_year_start_month: 4,
    original_text: text
  };
}

/**
 * Resolve until/before expressions
 */
function resolveUntil(
  text: string,
  now: Date,
  timezone: string
): TimeRange {
  const match = text.match(/(?:until|before|up to)\s+(.+)/);
  if (!match) {
    throw new Error(`Unable to parse until expression from: ${text}`);
  }
  
  const dateStr = match[1].trim();
  const end = parseRelativeOrAbsoluteDate(dateStr, now, timezone);
  
  return {
    mode: 'until',
    start: null,
    end: utils.formatDate(end, timezone),
    timezone,
    granularity: 'day',
    calendar_week_start: 'monday',
    fiscal_year_start_month: 4,
    original_text: text
  };
}

/**
 * Resolve comparison expressions (DoD, WoW, MoM, QoQ, YoY, SPLY)
 */
function resolveComparison(
  text: string,
  now: Date,
  timezone: string,
  weekStart: string,
  fiscalConfig: any
): TimeRange {
  let comparisonType: ComparisonType;
  let granularity: 'day' | 'week' | 'month' | 'quarter' | 'year';
  
  if (text.includes('day over day')) {
    comparisonType = 'DoD';
    granularity = 'day';
  } else if (text.includes('week over week')) {
    comparisonType = 'WoW';
    granularity = 'week';
  } else if (text.includes('month over month')) {
    comparisonType = 'MoM';
    granularity = 'month';
  } else if (text.includes('quarter over quarter')) {
    comparisonType = 'QoQ';
    granularity = 'quarter';
  } else if (text.includes('year over year')) {
    comparisonType = 'YoY';
    granularity = 'year';
  } else if (text.includes('same period last year')) {
    comparisonType = 'SPLY';
    granularity = 'year';
  } else if (text.includes('same period last week')) {
    comparisonType = 'same_period_last_week';
    granularity = 'week';
  } else if (text.includes('same period last month')) {
    comparisonType = 'same_period_last_month';
    granularity = 'month';
  } else if (text.includes('same period last quarter')) {
    comparisonType = 'same_period_last_quarter';
    granularity = 'quarter';
  } else {
    throw new Error(`Unable to determine comparison type from: ${text}`);
  }
  
  // Calculate base range (current period)
  const baseStart = utils.startOfPeriod(now, granularity, timezone, { 
    weekStart: weekStart as any, 
    fiscalConfig 
  });
  const baseEnd = utils.endOfPeriod(now, granularity, timezone, { 
    weekStart: weekStart as any, 
    fiscalConfig 
  });
  
  // Calculate comparison range (previous period)
  const compareStart = utils.subtractUnit(baseStart, granularity, timezone, { 
    weekStart: weekStart as any, 
    fiscalConfig 
  });
  const compareEnd = utils.subtractUnit(baseEnd, granularity, timezone, { 
    weekStart: weekStart as any, 
    fiscalConfig 
  });
  
  const baseRange: TimeRange = {
    mode: 'calendar',
    start: utils.formatDate(baseStart, timezone),
    end: utils.formatDate(baseEnd, timezone),
    timezone,
    granularity,
    calendar_week_start: weekStart as any,
    fiscal_year_start_month: fiscalConfig.fiscal_year_start_month,
    original_text: text
  };
  
  const compareRange: TimeRange = {
    mode: 'calendar',
    start: utils.formatDate(compareStart, timezone),
    end: utils.formatDate(compareEnd, timezone),
    timezone,
    granularity,
    calendar_week_start: weekStart as any,
    fiscal_year_start_month: fiscalConfig.fiscal_year_start_month,
    original_text: text
  };
  
  return {
    mode: 'comparison',
    start: utils.formatDate(baseStart, timezone),
    end: utils.formatDate(baseEnd, timezone),
    timezone,
    granularity,
    calendar_week_start: weekStart as any,
    fiscal_year_start_month: fiscalConfig.fiscal_year_start_month,
    comparison: {
      type: comparisonType,
      base_range: baseRange,
      compare_range: compareRange
    },
    original_text: text
  };
}

/**
 * Parse relative or absolute date string
 */
function parseRelativeOrAbsoluteDate(
  dateStr: string,
  now: Date,
  timezone: string
): Date {
  // Try ISO date format first
  const isoMatch = dateStr.match(/^\d{4}-\d{2}-\d{2}/);
  if (isoMatch) {
    return new Date(dateStr);
  }
  
  // Try month name format (e.g., "Jan 15", "January 15, 2024")
  for (const [name, month] of Object.entries(MONTH_NAMES)) {
    if (dateStr.includes(name)) {
      const yearMatch = dateStr.match(/\d{4}/);
      const dayMatch = dateStr.match(/\d{1,2}/);
      
      const year = yearMatch ? parseInt(yearMatch[0], 10) : now.getFullYear();
      const day = dayMatch ? parseInt(dayMatch[0], 10) : 1;
      
      return new Date(year, month - 1, day);
    }
  }
  
  // Try relative dates (e.g., "yesterday", "today", "tomorrow")
  if (dateStr === 'today') {
    return now;
  } else if (dateStr === 'yesterday') {
    return utils.addDays(now, -1);
  } else if (dateStr === 'tomorrow') {
    return utils.addDays(now, 1);
  }
  
  // Fallback to Date constructor
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  
  throw new Error(`Unable to parse date: ${dateStr}`);
}

/**
 * Parse explicit date when no terms detected
 */
function parseExplicitDate(
  text: string,
  now: Date,
  timezone: string
): TimeRange {
  const date = parseRelativeOrAbsoluteDate(text, now, timezone);
  const start = utils.startOfDay(date, timezone);
  const end = utils.endOfDay(date, timezone);
  
  return {
    mode: 'explicit',
    start: utils.formatDate(start, timezone),
    end: utils.formatDate(end, timezone),
    timezone,
    granularity: 'day',
    calendar_week_start: 'monday',
    fiscal_year_start_month: 4,
    original_text: text
  };
}
