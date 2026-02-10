/**
 * Time Utilities Module
 * 
 * Provides timezone-aware date calculation helpers for time range interpretation.
 * All functions are deterministic and handle edge cases (month boundaries, leap years, etc.)
 */

import { WeekStart, TimeGranularity, FiscalConfig } from './types.js';

/**
 * Parse a date string or Date object into a Date in the specified timezone
 */
export function parseDate(input: Date | string, timezone: string): Date {
  if (input instanceof Date) {
    return input;
  }
  
  // Parse ISO string
  const date = new Date(input);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }
  
  return date;
}

/**
 * Format a date as ISO 8601 string in the specified timezone
 */
export function formatDate(date: Date, timezone: string): string {
  // Use Intl.DateTimeFormat to get timezone-aware components
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  
  // Get timezone offset
  const offset = getTimezoneOffset(date, timezone);
  const offsetSign = offset >= 0 ? '+' : '-';
  const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

/**
 * Get timezone offset in minutes for a given date and timezone
 */
export function getTimezoneOffset(date: Date, timezone: string): number {
  // Create date strings in UTC and target timezone
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  
  // Offset in minutes
  return (tzDate.getTime() - utcDate.getTime()) / 60000;
}

/**
 * Get start of day in the specified timezone
 */
export function startOfDay(date: Date, timezone: string): Date {
  const formatted = formatDate(date, timezone);
  const datePart = formatted.split('T')[0];
  return new Date(`${datePart}T00:00:00${formatted.slice(formatted.indexOf('T') + 9)}`);
}

/**
 * Get end of day (start of next day) in the specified timezone
 */
export function endOfDay(date: Date, timezone: string): Date {
  const start = startOfDay(date, timezone);
  return addDays(start, 1);
}

/**
 * Get start of week in the specified timezone
 */
export function startOfWeek(date: Date, timezone: string, weekStart: WeekStart = 'monday'): Date {
  const dayOfWeek = getDayOfWeek(date, timezone);
  const targetDay = weekStart === 'monday' ? 1 : 0; // Monday = 1, Sunday = 0
  
  let daysToSubtract = dayOfWeek - targetDay;
  if (daysToSubtract < 0) {
    daysToSubtract += 7;
  }
  
  const weekStartDate = addDays(date, -daysToSubtract);
  return startOfDay(weekStartDate, timezone);
}

/**
 * Get end of week (start of next week) in the specified timezone
 */
export function endOfWeek(date: Date, timezone: string, weekStart: WeekStart = 'monday'): Date {
  const start = startOfWeek(date, timezone, weekStart);
  return addDays(start, 7);
}

/**
 * Get start of month in the specified timezone
 */
export function startOfMonth(date: Date, timezone: string): Date {
  const formatted = formatDate(date, timezone);
  const [datePart] = formatted.split('T');
  const [year, month] = datePart.split('-');
  const tzOffset = formatted.slice(formatted.indexOf('T') + 9);
  return new Date(`${year}-${month}-01T00:00:00${tzOffset}`);
}

/**
 * Get end of month (start of next month) in the specified timezone
 */
export function endOfMonth(date: Date, timezone: string): Date {
  const start = startOfMonth(date, timezone);
  return addMonths(start, 1, timezone);
}

/**
 * Get start of quarter in the specified timezone
 */
export function startOfQuarter(date: Date, timezone: string): Date {
  const formatted = formatDate(date, timezone);
  const [datePart] = formatted.split('T');
  const [year, month] = datePart.split('-');
  const monthNum = parseInt(month, 10);
  
  // Calendar quarter: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
  const quarterStartMonth = Math.floor((monthNum - 1) / 3) * 3 + 1;
  const quarterStartMonthStr = String(quarterStartMonth).padStart(2, '0');
  
  const tzOffset = formatted.slice(formatted.indexOf('T') + 9);
  return new Date(`${year}-${quarterStartMonthStr}-01T00:00:00${tzOffset}`);
}

/**
 * Get end of quarter (start of next quarter) in the specified timezone
 */
export function endOfQuarter(date: Date, timezone: string): Date {
  const start = startOfQuarter(date, timezone);
  return addMonths(start, 3, timezone);
}

/**
 * Get start of year in the specified timezone
 */
export function startOfYear(date: Date, timezone: string): Date {
  const formatted = formatDate(date, timezone);
  const [datePart] = formatted.split('T');
  const [year] = datePart.split('-');
  const tzOffset = formatted.slice(formatted.indexOf('T') + 9);
  return new Date(`${year}-01-01T00:00:00${tzOffset}`);
}

/**
 * Get end of year (start of next year) in the specified timezone
 */
export function endOfYear(date: Date, timezone: string): Date {
  const start = startOfYear(date, timezone);
  return addYears(start, 1, timezone);
}

/**
 * Get start of fiscal year in the specified timezone
 */
export function startOfFiscalYear(date: Date, timezone: string, fiscalConfig: FiscalConfig): Date {
  const formatted = formatDate(date, timezone);
  const [datePart] = formatted.split('T');
  const [year, month] = datePart.split('-');
  const monthNum = parseInt(month, 10);
  
  const fiscalStartMonth = fiscalConfig.fiscal_year_start_month;
  let fiscalYear = parseInt(year, 10);
  
  // If current month is before fiscal year start, fiscal year started last calendar year
  if (monthNum < fiscalStartMonth) {
    fiscalYear -= 1;
  }
  
  const fiscalStartMonthStr = String(fiscalStartMonth).padStart(2, '0');
  const tzOffset = formatted.slice(formatted.indexOf('T') + 9);
  return new Date(`${fiscalYear}-${fiscalStartMonthStr}-01T00:00:00${tzOffset}`);
}

/**
 * Get end of fiscal year (start of next fiscal year) in the specified timezone
 */
export function endOfFiscalYear(date: Date, timezone: string, fiscalConfig: FiscalConfig): Date {
  const start = startOfFiscalYear(date, timezone, fiscalConfig);
  return addYears(start, 1, timezone);
}

/**
 * Add days to a date
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Add weeks to a date
 */
export function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

/**
 * Add months to a date (handles month boundaries correctly)
 */
export function addMonths(date: Date, months: number, timezone: string): Date {
  const formatted = formatDate(date, timezone);
  const [datePart, timePart] = formatted.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  
  let newYear = year;
  let newMonth = month + months;
  
  // Handle month overflow/underflow
  while (newMonth > 12) {
    newMonth -= 12;
    newYear += 1;
  }
  while (newMonth < 1) {
    newMonth += 12;
    newYear -= 1;
  }
  
  // Handle day overflow (e.g., Jan 31 + 1 month = Feb 28/29)
  const daysInNewMonth = getDaysInMonth(newYear, newMonth);
  const newDay = Math.min(day, daysInNewMonth);
  
  const newMonthStr = String(newMonth).padStart(2, '0');
  const newDayStr = String(newDay).padStart(2, '0');
  
  return new Date(`${newYear}-${newMonthStr}-${newDayStr}T${timePart}`);
}

/**
 * Add quarters to a date
 */
export function addQuarters(date: Date, quarters: number, timezone: string): Date {
  return addMonths(date, quarters * 3, timezone);
}

/**
 * Add years to a date
 */
export function addYears(date: Date, years: number, timezone: string): Date {
  return addMonths(date, years * 12, timezone);
}

/**
 * Get day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 */
export function getDayOfWeek(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short'
  });
  
  const weekday = formatter.format(date);
  const days: Record<string, number> = {
    'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
  };
  
  return days[weekday] || 0;
}

/**
 * Get number of days in a month (handles leap years)
 */
export function getDaysInMonth(year: number, month: number): number {
  // Month is 1-indexed (1 = January, 12 = December)
  return new Date(year, month, 0).getDate();
}

/**
 * Check if a year is a leap year
 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Subtract one unit from a date based on granularity
 */
export function subtractUnit(date: Date, granularity: TimeGranularity, timezone: string, config?: { weekStart?: WeekStart; fiscalConfig?: FiscalConfig }): Date {
  switch (granularity) {
    case 'day':
      return addDays(date, -1);
    case 'week':
      return addWeeks(date, -1);
    case 'month':
      return addMonths(date, -1, timezone);
    case 'quarter':
      return addQuarters(date, -1, timezone);
    case 'year':
      return addYears(date, -1, timezone);
    case 'hour':
      return new Date(date.getTime() - 60 * 60 * 1000);
    case 'minute':
      return new Date(date.getTime() - 60 * 1000);
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}

/**
 * Get the start of a period based on granularity
 */
export function startOfPeriod(date: Date, granularity: TimeGranularity, timezone: string, config?: { weekStart?: WeekStart; fiscalConfig?: FiscalConfig }): Date {
  switch (granularity) {
    case 'day':
      return startOfDay(date, timezone);
    case 'week':
      return startOfWeek(date, timezone, config?.weekStart);
    case 'month':
      return startOfMonth(date, timezone);
    case 'quarter':
      return startOfQuarter(date, timezone);
    case 'year':
      if (config?.fiscalConfig) {
        return startOfFiscalYear(date, timezone, config.fiscalConfig);
      }
      return startOfYear(date, timezone);
    case 'hour':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
    case 'minute':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), 0, 0);
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}

/**
 * Get the end of a period based on granularity (start of next period)
 */
export function endOfPeriod(date: Date, granularity: TimeGranularity, timezone: string, config?: { weekStart?: WeekStart; fiscalConfig?: FiscalConfig }): Date {
  switch (granularity) {
    case 'day':
      return endOfDay(date, timezone);
    case 'week':
      return endOfWeek(date, timezone, config?.weekStart);
    case 'month':
      return endOfMonth(date, timezone);
    case 'quarter':
      return endOfQuarter(date, timezone);
    case 'year':
      if (config?.fiscalConfig) {
        return endOfFiscalYear(date, timezone, config.fiscalConfig);
      }
      return endOfYear(date, timezone);
    case 'hour':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1, 0, 0, 0);
    case 'minute':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes() + 1, 0, 0);
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}

/**
 * Calculate the difference between two dates in the specified granularity
 */
export function diffInUnits(start: Date, end: Date, granularity: TimeGranularity): number {
  const msPerUnit: Record<string, number> = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000
  };
  
  if (granularity in msPerUnit) {
    return Math.floor((end.getTime() - start.getTime()) / msPerUnit[granularity]);
  }
  
  // For week, month, quarter, year - use approximate calculations
  switch (granularity) {
    case 'week':
      return Math.floor((end.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
    case 'month':
      return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    case 'quarter':
      return Math.floor(((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth())) / 3);
    case 'year':
      return end.getFullYear() - start.getFullYear();
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}
