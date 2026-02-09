import fs from "fs";
import path from "path";
import yaml from "js-yaml";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SalesFunnelRules {
  section: Record<string, unknown>;
  query_categories: Record<string, QueryCategory>;
  core_rules: Record<string, CoreRule>;
  date_filters: Record<string, DateFilter>;
  funnel_stages: Record<string, unknown>;
  metrics: Record<string, unknown>;
  source_mapping: SourceMapping;
  status_logic: Record<string, unknown>;
  special_patterns: Record<string, unknown>;
  query_patterns: Record<string, QueryPattern>;
  anti_patterns: AntiPattern[];
  validation_checklist: ValidationChecklist;
  intent_classification: IntentClassification;
  metadata: Record<string, unknown>;
}

interface QueryCategory {
  description: string;
  patterns: string[];
}

interface CoreRule {
  description: string;
  sql_pattern?: string;
  applies_to: string | string[];
  mandatory: boolean;
  [key: string]: unknown;
}

interface DateFilter {
  description: string;
  applies_to: string[];
  date_filter_sql?: string;
  progressive_day_filter?: boolean;
  progressive_filter_sql?: string;
  [key: string]: unknown;
}

interface SourceMapping {
  description: string;
  categories: Record<string, { source_values: string[] }>;
  sql_case_statement: string;
}

interface QueryPattern {
  category: string;
  description: string;
  user_intent_keywords: string[];
  structure: string;
  applies_date_filter: string;
  [key: string]: unknown;
}

interface AntiPattern {
  pattern: string;
  why: string;
  wrong: string;
  correct: string;
}

interface ValidationChecklist {
  description: string;
  universal_checks: ValidationCheck[];
  category_specific_checks: Record<string, ValidationCheck[]>;
}

interface ValidationCheck {
  id: string;
  rule: string;
  check: string;
  applies_to?: string;
}

interface IntentClassification {
  description: string;
  classification_workflow: Record<string, string>;
  time_period_keywords: Record<string, KeywordMapping>;
  metric_keywords: Record<string, KeywordMapping>;
  granularity_keywords: Record<string, KeywordMapping>;
  filter_keywords: Record<string, KeywordMapping>;
}

interface KeywordMapping {
  keywords: string[];
  maps_to_filter?: string;
  suggests_categories?: string[];
  requires_pattern?: string[];
  suggests_pattern?: string[];
}

// ── Loader ─────────────────────────────────────────────────────────────────

const RULES_PATH =
  process.env.SALES_FUNNEL_RULES_PATH ||
  "/app/config/sales_funnel_rules_v2.yml";

let _rules: SalesFunnelRules | null = null;

export function loadRules(): SalesFunnelRules {
  if (_rules) return _rules;
  const raw = fs.readFileSync(RULES_PATH, "utf-8");
  _rules = yaml.load(raw) as SalesFunnelRules;
  return _rules;
}

// ── Context helpers ────────────────────────────────────────────────────────

/**
 * Returns the full schema intelligence context — core rules, funnel stages,
 * source mapping, anti-patterns, and validation checklist — so that an LLM
 * has everything it needs to generate correct SQL.
 */
export function getFullContext(): object {
  const rules = loadRules();
  return {
    section: rules.section,
    core_rules: rules.core_rules,
    date_filters: rules.date_filters,
    funnel_stages: rules.funnel_stages,
    metrics: rules.metrics,
    source_mapping: {
      description: rules.source_mapping.description,
      sql_case_statement: rules.source_mapping.sql_case_statement,
      categories: Object.fromEntries(
        Object.entries(rules.source_mapping.categories).map(([k, v]) => [
          k,
          v.source_values,
        ])
      ),
    },
    status_logic: rules.status_logic,
    anti_patterns: rules.anti_patterns,
    validation_checklist: rules.validation_checklist,
    tables: (rules.metadata as Record<string, unknown>).dependencies,
  };
}

/**
 * Classifies a user question against the intent keywords defined in the YAML
 * and returns the best-matching query pattern(s) along with all applicable
 * rules, date filters, and validation checks.
 */
export function classifyIntent(question: string): object {
  const rules = loadRules();
  const ic = rules.intent_classification;
  const q = question.toLowerCase();

  // Score each keyword group
  const matchedTimePeriods = matchKeywords(q, ic.time_period_keywords);
  const matchedMetrics = matchKeywords(q, ic.metric_keywords);
  const matchedGranularity = matchKeywords(q, ic.granularity_keywords);
  const matchedFilters = matchKeywords(q, ic.filter_keywords);

  // Collect suggested categories from all matches
  const suggestedCategories = new Set<string>();
  const requiredPatterns = new Set<string>();

  for (const m of [
    ...matchedMetrics,
    ...matchedGranularity,
    ...matchedFilters,
  ]) {
    const mapping = findMapping(m.group, ic);
    if (mapping?.suggests_categories) {
      mapping.suggests_categories.forEach((c) => suggestedCategories.add(c));
    }
    if (mapping?.requires_pattern) {
      mapping.requires_pattern.forEach((p) => requiredPatterns.add(p));
    }
    if (mapping?.suggests_pattern) {
      mapping.suggests_pattern.forEach((p) => requiredPatterns.add(p));
    }
  }

  // Determine date filter from time period
  let dateFilter: string | null = null;
  if (matchedTimePeriods.length > 0) {
    const tp = findMapping(matchedTimePeriods[0].group, ic);
    dateFilter = tp?.maps_to_filter ?? null;
  }

  // Resolve matching query patterns
  const matchingPatterns: Record<string, unknown>[] = [];
  for (const [patternName, pattern] of Object.entries(rules.query_patterns)) {
    const isRequired = requiredPatterns.has(patternName);
    const isCategoryMatch = suggestedCategories.has(pattern.category);
    const hasKeywordOverlap = pattern.user_intent_keywords.some((kw) =>
      q.includes(kw.toLowerCase())
    );

    if (isRequired || isCategoryMatch || hasKeywordOverlap) {
      // Gather all rules that apply to this pattern's category
      const applicableRules = getApplicableRules(pattern.category, rules);
      const applicableDateFilter = dateFilter
        ? rules.date_filters[dateFilter]
        : rules.date_filters[pattern.applies_date_filter];
      const validationChecks = getValidationChecks(pattern.category, rules);

      matchingPatterns.push({
        pattern_name: patternName,
        ...pattern,
        applicable_rules: applicableRules,
        date_filter: applicableDateFilter,
        validation_checks: validationChecks,
      });
    }
  }

  // If no patterns matched, default to mtd_funnel_current (most common)
  if (matchingPatterns.length === 0) {
    const fallback = rules.query_patterns["mtd_funnel_current"];
    if (fallback) {
      matchingPatterns.push({
        pattern_name: "mtd_funnel_current",
        ...fallback,
        applicable_rules: getApplicableRules(fallback.category, rules),
        date_filter: rules.date_filters[fallback.applies_date_filter],
        validation_checks: getValidationChecks(fallback.category, rules),
        note: "Fallback — no strong keyword match found",
      });
    }
  }

  return {
    question,
    matched_keywords: {
      time_period: matchedTimePeriods,
      metrics: matchedMetrics,
      granularity: matchedGranularity,
      filters: matchedFilters,
    },
    suggested_date_filter: dateFilter,
    matching_patterns: matchingPatterns,
    source_mapping_sql: rules.source_mapping.sql_case_statement,
    anti_patterns: rules.anti_patterns,
  };
}

/**
 * Returns the full rule set for a specific query pattern (by name).
 */
export function getQueryTemplate(patternName: string): object | null {
  const rules = loadRules();
  const pattern = rules.query_patterns[patternName];
  if (!pattern) return null;

  const category = pattern.category;
  const applicableRules = getApplicableRules(category, rules);
  const dateFilter = rules.date_filters[pattern.applies_date_filter];
  const validationChecks = getValidationChecks(category, rules);

  // Gather special pattern logic if referenced
  let specialLogic: unknown = null;
  if (pattern.uses_special_logic) {
    const key = String(pattern.uses_special_logic);
    if (key.includes(".")) {
      const [parent, child] = key.split(".");
      const sp = rules.special_patterns[parent] as Record<string, unknown> | undefined;
      specialLogic = sp ? { parent: sp, detail: sp[child] } : null;
    } else {
      specialLogic = rules.special_patterns[key] ?? null;
    }
  }

  // Gather relevant funnel stage definitions
  const stageDefinitions: Record<string, unknown> = {};
  for (const [stageName, stageDef] of Object.entries(rules.funnel_stages)) {
    stageDefinitions[stageName] = stageDef;
  }

  // Gather relevant metrics
  const relevantMetrics: Record<string, unknown> = {};
  for (const [metricName, metricDef] of Object.entries(rules.metrics)) {
    const md = metricDef as Record<string, unknown>;
    const appliesTo = md.applies_to as string[] | undefined;
    if (appliesTo && appliesTo.includes(category)) {
      relevantMetrics[metricName] = metricDef;
    }
  }

  return {
    pattern_name: patternName,
    pattern: pattern,
    core_rules: applicableRules,
    date_filter: dateFilter,
    funnel_stages: stageDefinitions,
    metrics: relevantMetrics,
    source_mapping: {
      sql: rules.source_mapping.sql_case_statement,
      categories: rules.source_mapping.categories,
    },
    special_logic: specialLogic,
    status_logic: rules.status_logic,
    validation_checks: validationChecks,
    anti_patterns: rules.anti_patterns,
  };
}

/**
 * Returns the list of available query patterns with descriptions and keywords.
 */
export function listQueryPatterns(): object[] {
  const rules = loadRules();
  return Object.entries(rules.query_patterns).map(([name, p]) => ({
    name,
    category: p.category,
    description: p.description,
    user_intent_keywords: p.user_intent_keywords,
  }));
}

// ── Internal helpers ───────────────────────────────────────────────────────

interface KeywordMatch {
  group: string;
  keyword: string;
}

function matchKeywords(
  question: string,
  keywordGroups: Record<string, KeywordMapping>
): KeywordMatch[] {
  const matches: KeywordMatch[] = [];
  for (const [group, mapping] of Object.entries(keywordGroups)) {
    for (const kw of mapping.keywords) {
      if (question.includes(kw.toLowerCase())) {
        matches.push({ group, keyword: kw });
        break; // one match per group is enough
      }
    }
  }
  return matches;
}

function findMapping(
  group: string,
  ic: IntentClassification
): KeywordMapping | null {
  for (const section of [
    ic.time_period_keywords,
    ic.metric_keywords,
    ic.granularity_keywords,
    ic.filter_keywords,
  ]) {
    if (section[group]) return section[group];
  }
  return null;
}

function getApplicableRules(
  category: string,
  rules: SalesFunnelRules
): Record<string, unknown> {
  const applicable: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(rules.core_rules)) {
    const appliesTo = rule.applies_to;
    if (
      appliesTo === "ALL queries" ||
      (typeof appliesTo === "string" && appliesTo.startsWith("ALL")) ||
      (Array.isArray(appliesTo) && appliesTo.includes(category))
    ) {
      applicable[name] = rule;
    }
  }
  return applicable;
}

function getValidationChecks(
  category: string,
  rules: SalesFunnelRules
): ValidationCheck[] {
  const checks: ValidationCheck[] = [
    ...(rules.validation_checklist.universal_checks ?? []),
  ];
  const specific =
    rules.validation_checklist.category_specific_checks?.[category];
  if (specific) {
    checks.push(...specific);
  }
  return checks;
}
