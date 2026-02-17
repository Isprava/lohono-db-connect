import { describe, it, expect } from "vitest";
import {
  buildSalesFunnelQuery,
  buildLeadsQuery,
  buildProspectsQuery,
  buildAccountsQuery,
  buildSalesQuery,
} from "../sales-funnel-builder.js";

describe("sales-funnel-builder", () => {
  describe("parameterization", () => {
    it("buildLeadsQuery uses $N placeholders instead of string interpolation for slug exclusions", () => {
      const { sql, params } = buildLeadsQuery();

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

    it("buildLeadsQuery parameterizes the DnB exclusion", () => {
      const { sql, params } = buildLeadsQuery();

      // Should NOT have hardcoded 'DnB' in the SQL
      expect(sql).not.toMatch(/'DnB'/);

      // Should have DnB as a param value
      expect(params).toContain("DnB");
    });

    it("buildSalesFunnelQuery returns params that are a superset of all sub-queries", () => {
      const funnel = buildSalesFunnelQuery();
      const leads = buildLeadsQuery();
      const prospects = buildProspectsQuery();

      // Funnel params should include all lead params (slugs + DnB)
      for (const p of leads.params) {
        expect(funnel.params).toContain(p);
      }

      // Funnel params should include all prospect params (slugs only)
      for (const p of prospects.params) {
        expect(funnel.params).toContain(p);
      }
    });

    it("buildProspectsQuery does NOT include DnB exclusion", () => {
      const { sql, params } = buildProspectsQuery();

      // No DnB-related content
      expect(params).not.toContain("DnB");
      expect(sql).not.toContain("source");
    });

    it("all builders use $1 and $2 for date range", () => {
      for (const builder of [buildLeadsQuery, buildProspectsQuery, buildAccountsQuery, buildSalesQuery, buildSalesFunnelQuery]) {
        const { sql } = builder();
        expect(sql).toContain("$1::date");
        expect(sql).toContain("$2::date");
      }
    });
  });

  describe("query structure", () => {
    it("buildSalesFunnelQuery produces a UNION ALL of all 4 metrics", () => {
      const { sql } = buildSalesFunnelQuery();
      expect(sql).toContain("UNION ALL");
      expect(sql).toContain("'Leads'");
      expect(sql).toContain("'Prospects'");
      expect(sql).toContain("'Accounts'");
      expect(sql).toContain("'Sales'");
    });

    it("buildSalesFunnelQuery orders metrics correctly", () => {
      const { sql } = buildSalesFunnelQuery();
      expect(sql).toContain("WHEN metric = 'Leads' THEN 1");
      expect(sql).toContain("WHEN metric = 'Sales' THEN 4");
    });

    it("buildLeadsQuery uses UNION ALL for opportunities + enquiries", () => {
      const { sql } = buildLeadsQuery();
      expect(sql).toContain("UNION ALL");
      expect(sql).toContain("development_opportunities");
      expect(sql).toContain("enquiries");
    });
  });
});
