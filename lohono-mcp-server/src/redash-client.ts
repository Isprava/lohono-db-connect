/**
 * Redash API Client
 *
 * Fetches SQL query definitions from a Redash instance by query ID.
 * Supports single and batch fetches.
 *
 * Config (env vars):
 *   REDASH_URL      – base URL (default: https://redash.isprava.com)
 *   REDASH_API_KEY  – API key for authentication
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface RedashQuery {
  id: number;
  name: string;
  description: string;
  query: string;
  data_source_id: number;
  schedule: unknown;
  tags: string[];
  is_archived: boolean;
  is_draft: boolean;
  created_at: string;
  updated_at: string;
  user: { id: number; name: string; email: string };
  options: Record<string, unknown>;
}

export interface RedashFetchResult {
  id: number;
  success: boolean;
  query?: RedashQuery;
  error?: string;
}

// ── Client ─────────────────────────────────────────────────────────────────

export class RedashClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = (baseUrl || process.env.REDASH_URL || "https://redash.isprava.com").replace(
      /\/$/,
      ""
    );
    this.apiKey = apiKey || process.env.REDASH_API_KEY || "";

    if (!this.apiKey) {
      throw new Error(
        "Redash API key is required. Set REDASH_API_KEY env var or pass it to the constructor."
      );
    }
  }

  /** Fetch a single query by ID */
  async fetchQuery(queryId: number): Promise<RedashFetchResult> {
    const url = `${this.baseUrl}/api/queries/${queryId}`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Key ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          id: queryId,
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        };
      }

      const data = (await response.json()) as RedashQuery;
      return { id: queryId, success: true, query: data };
    } catch (err) {
      return {
        id: queryId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Fetch multiple queries by ID (sequentially to avoid hammering the API) */
  async fetchQueries(queryIds: number[]): Promise<RedashFetchResult[]> {
    const results: RedashFetchResult[] = [];
    for (const id of queryIds) {
      results.push(await this.fetchQuery(id));
    }
    return results;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a query-ID input string.
 * Accepts:
 *   - A single numeric ID:       "42"
 *   - Comma-separated IDs:       "42,99,103"
 *   - Whitespace-separated IDs:  "42 99 103"
 *   - A mix:                     "42, 99,  103"
 */
export function parseQueryIds(input: string): number[] {
  return input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = parseInt(s, 10);
      if (isNaN(n)) throw new Error(`Invalid query ID: "${s}"`);
      return n;
    });
}
