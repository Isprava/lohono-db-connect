
export interface SalesFunnelConfig {
    section: Section;
    query_categories: Record<string, QueryCategory>;
    core_rules: CoreRules;
    date_filters: Record<string, DateFilter>;
    funnel_stages: FunnelStages;
    metrics: Record<string, MetricDefinition>;
    source_mapping: SourceMapping;
    status_logic: StatusLogic;
    special_patterns: Record<string, SpecialPattern>;
    query_patterns: Record<string, QueryPattern>;
}

export interface Section {
    name: string;
    description: string;
    vertical: string;
}

export interface QueryCategory {
    description: string;
    patterns: string[];
}

export interface CoreRules {
    timezone_conversion: Rule;
    slug_exclusions: ExclusionRule;
    distinct_counting: Rule;
    source_exclusion_dnb: ExclusionRule;
}

export interface Rule {
    description: string;
    sql_pattern?: string;
    alternative_pattern?: string;
    applies_to: string | string[];
    mandatory: boolean;
    validation?: string;
    note?: string;
    reason?: string;
}

export interface ExclusionRule extends Rule {
    values?: string[];
    excludes_from?: string[];
    applies_to_tables?: string[];
    never_apply_to_tables?: string[];
    applies_to_metrics?: string[];
    never_apply_to_metrics?: string[];
    tables?: string[];
}

export interface DateFilter {
    description: string;
    applies_to: string[];
    patterns_using?: string[];
    start_date_sql: string;
    end_date_sql?: string;
    date_filter_sql: string;
    progressive_day_filter: boolean;
    progressive_filter_sql?: string;
    reference_date?: string;
    note?: string;
}

export interface FunnelStages {
    [key: string]: FunnelStage;
}

export type FunnelStageType = "single_source" | "multi_source" | "join_source";

export interface FunnelStage {
    metric_name: string;
    sort_order: number;
    type: FunnelStageType;
    description: string;
    timestamp_columns?: Record<string, string>;
    timestamp_column?: string;
    table?: string;
    // multi_source fields
    source_1_opportunities?: SourceConfig;
    source_2_enquiries?: SourceConfig;
    combination_logic?: string;
    // join_source fields
    tables?: string[];
    join_conditions?: string[];
    timestamp_table?: string;
    // common fields
    count_expression: string;
    mandatory_conditions: string[];
    mandatory_exclusions: string[];
    no_source_exclusion?: boolean;
    applies_timezone: boolean;
    applies_date_filter: boolean;
    applies_progressive_filter: boolean;
    note?: string;
}

export interface SourceConfig {
    table: string;
    timestamp_column: string;
    count_expression: string;
    mandatory_conditions: string[];
    mandatory_exclusions: string[];
    applies_timezone: boolean;
    applies_date_filter: boolean;
    applies_progressive_filter: boolean;
    note?: string;
}

export interface MetricDefinition {
    description: string;
    applies_to: string[];
    patterns_using: string[];
    required_tables?: string[];
    join_conditions?: string[];
    filter_conditions?: string[];
    timestamp_column?: string;
    count_expression?: string;
    applies_timezone: boolean;
    applies_date_filter: boolean;
    applies_progressive_filter: boolean;
    no_slug_exclusions?: boolean;
    regional_filter?: string;
    table?: string;
    calculation_sql?: string;
    aggregation?: string;
    cast_to?: string;
    requires_both_columns?: string[];
    filter_on_column?: string;
    applies_slug_exclusions?: boolean;
    note?: string;
}

export interface SourceMapping {
    description: string;
    applies_to: string[];
    categories: Record<string, SourceCategory>;
    sql_case_statement: string;
}

export interface SourceCategory {
    source_values: string[];
    is_default?: boolean;
}

export interface StatusLogic {
    open_definition: OpenDefinition;
    closed_reason_extraction: ClosedReasonExtraction;
    stage_history_joins: Record<string, StageHistoryJoin>;
    maal_laao_date_from_tasks: MaalLaaoDateFromTasks;
}

export interface OpenDefinition {
    description: string;
    applies_to: string[];
    patterns_using: string[];
    for_opportunities: ConditionBlock;
    for_enquiries: ConditionBlock;
}

export interface ConditionBlock {
    conditions: string[];
    filters?: string[];
}

export interface ClosedReasonExtraction {
    description: string;
    applies_to: string[];
    patterns_using: string[];
    required_tables: string[];
    join_conditions: string[];
    filter_conditions: string[];
    extraction_sql: string;
    explanation_sql: string;
    ranking_logic: RankingLogic;
    multiple_reasons_handling: MultipleReasonsHandling;
    null_handling: NullHandling;
    display_transformation: DisplayTransformation;
    conditional_display: ConditionalDisplay;
}

export interface RankingLogic {
    sql: string;
    select_rank: number;
    note?: string;
}

export interface MultipleReasonsHandling {
    description: string;
    issue: string;
    mandatory: boolean;
    deduplication_method: string;
    sql: string;
    selection_logic: string;
    alternative_method: string;
    alternative_note: string;
    example_scenario: string;
}

export interface NullHandling {
    when_null_or_empty: string;
    when_equals_others: string;
}

export interface DisplayTransformation {
    sql: string;
}

export interface ConditionalDisplay {
    sql: string;
    applies_to_pattern: string;
}

export interface StageHistoryJoin {
    tables: string[];
    join_conditions: string[];
    filter_conditions: string[];
    ranking: RankingLogic;
    date_expression: string;
}

export interface MaalLaaoDateFromTasks {
    description: string;
    applies_to: string[];
    patterns_using: string[];
    tables: string[];
    join_conditions: string[];
    filter_conditions: string[];
    ranking: RankingLogic;
    date_expression: string;
    applies_slug_exclusions: boolean;
}

export interface SpecialPattern {
    description: string;
    pattern_name?: string;
    pattern_names?: string[];
    applies_to: string[];
    [key: string]: any; // Allow arbitrary properties for special logic
}

export interface QueryPattern {
    category: string;
    description: string;
    user_intent_keywords: string[];
    structure: string;
    metrics_included?: string[];
    output?: string;
    uses_special_logic?: string;
    applies_date_filter: string;
    applies_timezone: boolean;
    applies_progressive_filter: boolean;
    applies_slug_exclusions: boolean;
    applies_source_exclusion?: string | boolean;
    applies_distinct_counting?: boolean;
    reference_date?: string;
    applies_source_mapping?: boolean;
    applies_open_status_logic?: boolean;
    includes_stage_history?: boolean;
    includes_closed_reasons?: boolean;
    includes_maal_laao_from_tasks?: boolean;
    includes_conditional_display?: boolean;
    aggregation?: boolean;
    row_level?: boolean;
}
