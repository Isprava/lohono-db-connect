import { buildLeadsQuery, buildProspectsQuery, buildAccountsQuery, buildSalesQuery } from './sales-funnel-builder.js';
import { Vertical } from '../../shared/types/verticals.js';

console.log("--- Testing THE_CHAPTER Queries ---");

console.log("\n1. LEADS:");
try {
    console.log(buildLeadsQuery(Vertical.THE_CHAPTER, ['Goa']));
} catch (e) { console.error(e); }

console.log("\n2. PROSPECTS (Location: 'Goa'):");
try {
    console.log(buildProspectsQuery(Vertical.THE_CHAPTER, ['Goa']));
} catch (e) { console.error(e); }

console.log("\n2b. PROSPECTS (No Location):");
try {
    console.log(buildProspectsQuery(Vertical.THE_CHAPTER, []));
} catch (e) { console.error(e); }

console.log("\n3. ACCOUNTS (Location: 'Goa'):");
try {
    console.log(buildAccountsQuery(Vertical.THE_CHAPTER, ['Goa']));
} catch (e) { console.error(e); }

console.log("\n3b. ACCOUNTS (No Location):");
try {
    console.log(buildAccountsQuery(Vertical.THE_CHAPTER, []));
} catch (e) { console.error(e); }

console.log("\n4. SALES (Location: 'Goa'):");
try {
    console.log(buildSalesQuery(Vertical.THE_CHAPTER, ['Goa']));
} catch (e) { console.error(e); }

console.log("\n4b. SALES (No Location):");
try {
    console.log(buildSalesQuery(Vertical.THE_CHAPTER, []));
} catch (e) { console.error(e); }
