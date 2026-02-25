/**
 * Ad-hoc test: run the Chapter YTD scorecard query against the live DB
 * and print a formatted pivot result.
 *
 * Usage:
 *   DB_HOST=... DB_PORT=... tsx lohono-mcp-server/src/test-chapter-scorecard.ts
 * or just:
 *   tsx lohono-mcp-server/src/test-chapter-scorecard.ts   (reads .env)
 */
import { config } from "dotenv";
config({ path: ".env" });

import pg from "pg";
import { buildChapterFunnelQuery } from "./chapter-funnel-builder.js";

// ── IST date range helpers ────────────────────────────────────────────────────

function getIST(): { year: number; month: string; day: string } {
    const istMs = 5.5 * 60 * 60 * 1000;
    const d = new Date(Date.now() + istMs);
    return {
        year: d.getUTCFullYear(),
        month: String(d.getUTCMonth() + 1).padStart(2, "0"),
        day: String(d.getUTCDate()).padStart(2, "0"),
    };
}

function ytdRange(): { start: string; end: string; label: string } {
    const { year, month, day } = getIST();
    return { start: `${year}-01-01`, end: `${year}-${month}-${day}`, label: "YTD" };
}
function lystdRange(): { start: string; end: string; label: string } {
    const { year, month, day } = getIST();
    return { start: `${year - 1}-01-01`, end: `${year - 1}-${month}-${day}`, label: "LYSTD" };
}

// ── Pivot helper ──────────────────────────────────────────────────────────────

const NAME_TO_KEY: Record<string, string> = {
    Viewings: "viewings", Meetings: "meetings",
    "12P": "l2p", P2A: "p2a", A2S: "a2s",
    Leads: "leads", Prospects: "prospects",
    Accounts: "accounts", Sales: "sales",
};

function pivot(rows: { metric: string; count: number }[]) {
    const out: Record<string, number> = {};
    for (const row of rows) {
        const key = NAME_TO_KEY[row.metric];
        if (key) out[key] = row.count ?? 0;
    }
    return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "postgres",
    ssl: false,
    connectionTimeoutMillis: 10_000,
});

async function run(period: "ytd" | "lystd") {
    const range = period === "ytd" ? ytdRange() : lystdRange();
    console.log(`\n─── ${range.label}: ${range.start}  →  ${range.end} ───`);

    const query = buildChapterFunnelQuery();           // no location filter
    const params = [range.start, range.end, ...query.params];

    const t0 = Date.now();
    const result = await pool.query(query.sql, params);
    const ms = Date.now() - t0;

    const scorecard = pivot(result.rows as { metric: string; count: number }[]);

    // Pretty-print ordered table
    const ORDER = ["leads", "prospects", "accounts", "sales", "meetings", "viewings", "l2p", "p2a", "a2s"];
    console.log("\n metric      | count");
    console.log(" ---------------------");
    for (const key of ORDER) {
        const val = scorecard[key] ?? "—";
        console.log(` ${key.padEnd(11)} | ${val}`);
    }
    console.log(`\n(${result.rowCount} raw rows, ${ms}ms)`);

    return scorecard;
}

(async () => {
    try {
        await run("ytd");
        await run("lystd");
    } finally {
        await pool.end();
    }
})();
