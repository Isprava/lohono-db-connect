import { describe, it, expect } from "vitest";
import {
  buildSalesFunnelQuery,
  buildMetricQuery,
} from "../sales-funnel-builder.js";

describe("sales-funnel-builder", () => {
  describe("parameterization", () => {
    it("lead metric uses $N placeholders instead of string interpolation for slug exclusions", () => {
      const { sql, params } = buildMetricQuery("lead", "isprava" as any);

      // Should NOT contain hardcoded slug values in the SQL
      expect(sql).not.toContain("'569657C6'");
      expect(sql).not.toContain("'5EB1A14A'");
      expect(sql).not.toContain("'075E54DF'");

      // Should contain $N placeholders for slugs (starting at $3)
      expect(sql).toContain("$3");

      // Slug values should be in the params array
      expect(params).toContain("569657C6");
      expect(params).toContain("5EB1A14A");
      expect(params).toContain("075E54DF");
    });

    it("lead metric parameterizes the DnB exclusion", () => {
      const { sql, params } = buildMetricQuery("lead", "isprava" as any);

      // Should NOT have hardcoded 'DnB' in the SQL
      expect(sql).not.toMatch(/'DnB'/);

      // Should have DnB as a param value
      expect(params).toContain("DnB");
    });

    it("buildSalesFunnelQuery returns params that are a superset of all sub-queries", () => {
      const funnel = buildSalesFunnelQuery("isprava" as any);
      const leads = buildMetricQuery("lead", "isprava" as any);
      const prospects = buildMetricQuery("prospect", "isprava" as any);

      // Funnel params should include all lead params (slugs + DnB)
      for (const p of leads.params) {
        expect(funnel.params).toContain(p);
      }

      // Funnel params should include all prospect params (slugs only)
      for (const p of prospects.params) {
        expect(funnel.params).toContain(p);
      }
    });

    it("prospect metric does NOT include DnB exclusion", () => {
      const { sql, params } = buildMetricQuery("prospect", "isprava" as any);

      // No DnB-related content
      expect(params).not.toContain("DnB");
      expect(sql).not.toContain("source");
    });

    it("all metrics use $1 and $2 for date range", () => {
      for (const key of ["lead", "prospect", "account", "sale"]) {
        const { sql } = buildMetricQuery(key, "isprava" as any);
        expect(sql).toMatch(/\$1/);
        expect(sql).toMatch(/\$2/);
      }
      const { sql } = buildSalesFunnelQuery("isprava" as any);
      expect(sql).toMatch(/\$1/);
      expect(sql).toMatch(/\$2/);
    });
  });

  describe("query structure", () => {
    it("buildSalesFunnelQuery produces a UNION ALL of all 4 metrics", () => {
      const { sql } = buildSalesFunnelQuery("isprava" as any);
      expect(sql).toContain("UNION ALL");
      expect(sql).toContain("'Leads'");
      expect(sql).toContain("'Prospects'");
      expect(sql).toContain("'Accounts'");
      expect(sql).toContain("'Sales'");
    });

    it("buildSalesFunnelQuery orders metrics correctly", () => {
      const { sql } = buildSalesFunnelQuery("isprava" as any);
      expect(sql).toContain("WHEN metric = 'Leads' THEN 1");
      expect(sql).toContain("WHEN metric = 'Sales' THEN 4");
    });

    it("lead metric uses UNION ALL for opportunities + enquiries", () => {
      const { sql } = buildMetricQuery("lead", "isprava" as any);
      expect(sql).toContain("UNION ALL");
      expect(sql).toContain("development_opportunities");
      expect(sql).toContain("enquiries");
    });

    it("single metric mode returns only that metric", () => {
      const { sql } = buildSalesFunnelQuery("isprava" as any, undefined, "prospect");
      expect(sql).toContain("'Prospects'");
      expect(sql).not.toContain("'Leads'");
      expect(sql).not.toContain("'Sales'");
    });

    it("throws for unknown metric key", () => {
      expect(() => buildMetricQuery("nonexistent", "isprava" as any)).toThrow("Unknown funnel metric");
    });
  });
});
