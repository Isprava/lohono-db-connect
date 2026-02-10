/**
 * Time Range Schema and Types for NLQ Time-Range Interpretation
 * 
 * Provides deterministic conversion of natural language time expressions
 * (MTD, WTD, YTD, "last 7 days", etc.) into canonical date filter objects.
 */

/**
 * Granularity of time periods
 */
export type TimeGranularity = 
  | "minute" 
  | "hour" 
  | "day" 
  | "week" 
  | "month" 
  | "quarter" 
  | "year";

/**
 * Day of week for calendar week start
 */
export type WeekStart = "monday" | "sunday";

/**
 * Time range interpretation mode
 */
export type TimeRangeMode =
  | "calendar"      // Calendar-aligned periods (this month, last quarter)
  | "rolling"       // Rolling windows (last 7 days, past 30 days)
  | "explicit"      // Explicit date ranges (between X and Y)
  | "to_date"       // To-date expressions (MTD, YTD, QTD)
  | "since"         // Open-ended from date (since X)
  | "until"         // Open-ended to date (until X)
  | "comparison";   // Comparison ranges (YoY, MoM, WoW)

/**
 * Comparison type for period-over-period analysis
 */
export type ComparisonType =
  | "DoD"  // Day over Day
  | "WoW"  // Week over Week
  | "MoM"  // Month over Month
  | "QoQ"  // Quarter over Quarter
  | "YoY"  // Year over Year
  | "SPLY" // Same Period Last Year
  | "same_period_last_week"
  | "same_period_last_month"
  | "same_period_last_quarter"
  | "same_period_last_year";

/**
 * Fiscal year configuration
 */
export interface FiscalConfig {
  /** Starting month of fiscal year (1-12, e.g., 4 for April) */
  fiscal_year_start_month: number;
  /** Label for fiscal year (e.g., "FY" or "Fiscal") */
  fiscal_year_label?: string;
}

/**
 * Comparison range structure
 */
export interface ComparisonRange {
  /** Type of comparison */
  type: ComparisonType;
  /** Base range being compared */
  base_range: TimeRange;
  /** Derived comparison range */
  compare_range: TimeRange;
}

/**
 * Main TimeRange schema
 * 
 * Represents a deterministic time range with all necessary configuration
 * for downstream SQL generation.
 */
export interface TimeRange {
  /** Interpretation mode */
  mode: TimeRangeMode;
  
  /** Start date-time (inclusive), null if open-ended */
  start: string | null;
  
  /** End date-time (exclusive preferred), null if open-ended */
  end: string | null;
  
  /** IANA timezone string or fixed offset (default: "Asia/Kolkata") */
  timezone: string;
  
  /** Granularity of the time period */
  granularity: TimeGranularity;
  
  /** Day that calendar week starts on (default: "monday") */
  calendar_week_start: WeekStart;
  
  /** Fiscal year configuration (default: April = 4) */
  fiscal_year_start_month: number;
  
  /** Optional comparison structure for period-over-period analysis */
  comparison?: ComparisonRange;
  
  /** Original NLQ text that generated this range (for debugging) */
  original_text?: string;
}

/**
 * Detected time term with confidence
 */
export interface DetectedTimeTerm {
  /** Matched token/phrase */
  token: string;
  /** Type of time expression */
  type: TimeRangeMode | "relative" | "absolute";
  /** Confidence score 0-1 */
  confidence: number;
  /** Start position in original text */
  start_pos: number;
  /** End position in original text */
  end_pos: number;
}

/**
 * Time range parser configuration
 */
export interface TimeRangeConfig {
  /** Default timezone for interpretation */
  timezone: string;
  /** Fiscal year configuration */
  fiscal_config: FiscalConfig;
  /** Week start day */
  week_start: WeekStart;
  /** Reference "now" for deterministic testing */
  now?: Date | string;
}

/**
 * Default configuration
 */
export const DEFAULT_TIME_RANGE_CONFIG: TimeRangeConfig = {
  timezone: "Asia/Kolkata",
  fiscal_config: {
    fiscal_year_start_month: 4, // April
    fiscal_year_label: "FY"
  },
  week_start: "monday"
};

/**
 * NLQ vocabulary mapping
 * Maps various synonyms and abbreviations to canonical forms
 */
export const NLQ_VOCABULARY = {
  // To-date terms
  to_date: [
    "WTD", "week to date", "week-to-date",
    "MTD", "month to date", "month-to-date",
    "QTD", "quarter to date", "quarter-to-date",
    "YTD", "year to date", "year-to-date",
    "FYTD", "fiscal year to date", "fiscal-year-to-date",
    "PTD", "period to date", "period-to-date"
  ],
  
  // Calendar terms
  calendar: [
    "this week", "current week", "this month", "current month",
    "this quarter", "current quarter", "this year", "current year",
    "last week", "previous week", "past week",
    "last month", "previous month", "past month",
    "last quarter", "previous quarter", "past quarter",
    "last year", "previous year", "past year",
    "next week", "next month", "next quarter", "next year"
  ],
  
  // Rolling window terms
  rolling: [
    "last N days", "past N days", "trailing N days",
    "last N weeks", "past N weeks", "trailing N weeks",
    "last N months", "past N months", "trailing N months",
    "last N quarters", "past N quarters", "trailing N quarters",
    "last N years", "past N years", "trailing N years",
    "L7D", "L30D", "L90D", "L12M", "L4W"
  ],
  
  // Comparison terms
  comparison: [
    "DoD", "day over day", "day-over-day",
    "WoW", "week over week", "week-over-week",
    "MoM", "month over month", "month-over-month",
    "QoQ", "quarter over quarter", "quarter-over-quarter",
    "YoY", "year over year", "year-over-year",
    "SPLY", "same period last year",
    "same period last week", "same period last month",
    "same period last quarter"
  ],
  
  // Explicit range terms
  explicit: [
    "between", "from", "to", "..", "through", "thru"
  ],
  
  // Open-ended terms
  open_ended: [
    "since", "after", "before", "until", "up to"
  ]
} as const;

/**
 * Abbreviated form mappings
 */
export const ABBREVIATIONS: Record<string, string> = {
  // To-date
  "WTD": "week to date",
  "MTD": "month to date",
  "QTD": "quarter to date",
  "YTD": "year to date",
  "FYTD": "fiscal year to date",
  "PTD": "period to date",
  
  // Rolling windows
  "L7D": "last 7 days",
  "L30D": "last 30 days",
  "L90D": "last 90 days",
  "L12M": "last 12 months",
  "L4W": "last 4 weeks",
  
  // Comparisons
  "DoD": "day over day",
  "WoW": "week over week",
  "MoM": "month over month",
  "QoQ": "quarter over quarter",
  "YoY": "year over year",
  "SPLY": "same period last year"
};

/**
 * Month name mappings
 */
export const MONTH_NAMES: Record<string, number> = {
  "january": 1, "jan": 1,
  "february": 2, "feb": 2,
  "march": 3, "mar": 3,
  "april": 4, "apr": 4,
  "may": 5,
  "june": 6, "jun": 6,
  "july": 7, "jul": 7,
  "august": 8, "aug": 8,
  "september": 9, "sep": 9, "sept": 9,
  "october": 10, "oct": 10,
  "november": 11, "nov": 11,
  "december": 12, "dec": 12
};

/**
 * Quarter mappings
 */
export const QUARTER_MONTHS: Record<number, number> = {
  1: 1,  // Q1 starts in January (calendar year)
  2: 4,  // Q2 starts in April
  3: 7,  // Q3 starts in July
  4: 10  // Q4 starts in October
};
