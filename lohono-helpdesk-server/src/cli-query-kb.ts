#!/usr/bin/env node
/**
 * CLI tool to query the AWS Bedrock Knowledge Base directly.
 *
 * Usage:
 *   npx tsx lohono-helpdesk-server/src/cli-query-kb.ts "What is the cancellation policy?"
 *   npx tsx lohono-helpdesk-server/src/cli-query-kb.ts --retrieve-only "cancellation policy"
 *
 * Options:
 *   --retrieve-only   Use Retrieve API (raw document chunks) instead of RetrieveAndGenerate
 *   --results N       Number of results to retrieve (default: 5)
 *   --search-type     Search type: SEMANTIC | HYBRID (default: SEMANTIC)
 *
 * Reads AWS config from .env (BEDROCK_KB_ID, AWS_REGION, AWS_ACCESS_KEY_ID, etc.)
 */

import "dotenv/config";
import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";

// ── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

let retrieveOnly = false;
let numberOfResults = 5;
let searchType: "SEMANTIC" | "HYBRID" = "SEMANTIC";
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--retrieve-only") {
    retrieveOnly = true;
  } else if (arg === "--results" && i + 1 < args.length) {
    numberOfResults = parseInt(args[++i], 10);
  } else if (arg === "--search-type" && i + 1 < args.length) {
    searchType = args[++i] as "SEMANTIC" | "HYBRID";
  } else if (arg === "--help" || arg === "-h") {
    console.log(`
Usage:
  npx tsx lohono-helpdesk-server/src/cli-query-kb.ts [options] "your question"

Options:
  --retrieve-only   Return raw document chunks (Retrieve API) instead of a generated answer
  --results N       Number of results to retrieve (default: 5)
  --search-type T   SEMANTIC or HYBRID (default: SEMANTIC)
  -h, --help        Show this help message
`);
    process.exit(0);
  } else {
    positional.push(arg);
  }
}

const question = positional.join(" ").trim();
if (!question) {
  console.error("Error: Please provide a question as an argument.");
  console.error('  npx tsx lohono-helpdesk-server/src/cli-query-kb.ts "your question"');
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────────────────────

const AWS_REGION = process.env.AWS_REGION || "ap-south-1";
const KNOWLEDGE_BASE_ID = process.env.BEDROCK_KB_ID || "";
const MODEL_ARN =
  process.env.BEDROCK_MODEL_ARN ||
  `arn:aws:bedrock:${AWS_REGION}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`;

if (!KNOWLEDGE_BASE_ID) {
  console.error("Error: BEDROCK_KB_ID is not set in .env");
  process.exit(1);
}

const client = new BedrockAgentRuntimeClient({
  region: AWS_REGION,
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

// ── Query ───────────────────────────────────────────────────────────────────

console.log("─".repeat(70));
console.log(`KB ID:        ${KNOWLEDGE_BASE_ID}`);
console.log(`Region:       ${AWS_REGION}`);
console.log(`Model ARN:    ${MODEL_ARN}`);
console.log(`Mode:         ${retrieveOnly ? "Retrieve (raw chunks)" : "RetrieveAndGenerate"}`);
console.log(`Search type:  ${searchType}`);
console.log(`Max results:  ${numberOfResults}`);
console.log(`Question:     ${question}`);
console.log("─".repeat(70));

try {
  if (retrieveOnly) {
    // ── Retrieve API: raw document chunks ─────────────────────────────────
    const command = new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: question },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults,
          overrideSearchType: searchType,
        },
      },
    });

    const response = await client.send(command);
    const results = response.retrievalResults || [];

    console.log(`\nRetrieved ${results.length} chunk(s):\n`);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const score = r.score?.toFixed(4) ?? "N/A";
      const uri = r.location?.s3Location?.uri ?? "unknown";
      const text = r.content?.text ?? "(no text)";

      console.log(`── Chunk ${i + 1} (score: ${score}) ──`);
      console.log(`   Source: ${uri}`);
      console.log(`   Text:\n${text.split("\n").map((l) => "   " + l).join("\n")}`);
      console.log();
    }

    if (results.length === 0) {
      console.log("No document chunks matched the query.");
      console.log("This means the Knowledge Base has no relevant documents indexed.");
      console.log("\nTroubleshooting:");
      console.log("  1. Check that documents are uploaded to the S3 data source");
      console.log("  2. Verify the Knowledge Base has been synced after uploading");
      console.log("  3. Try a broader query term");
    }
  } else {
    // ── RetrieveAndGenerate API: generated answer ─────────────────────────
    const command = new RetrieveAndGenerateCommand({
      input: { text: question },
      retrieveAndGenerateConfiguration: {
        type: "KNOWLEDGE_BASE",
        knowledgeBaseConfiguration: {
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          modelArn: MODEL_ARN,
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults,
              overrideSearchType: searchType,
            },
          },
        },
      },
    });

    const response = await client.send(command);
    const answerText = response.output?.text || "(no answer generated)";

    console.log("\n=== Generated Answer ===\n");
    console.log(answerText);

    // Show citations
    const citations = response.citations || [];
    if (citations.length > 0) {
      console.log("\n=== Citations ===\n");
      for (const citation of citations) {
        const refs = citation.retrievedReferences || [];
        for (const ref of refs) {
          const uri = ref.location?.s3Location?.uri ?? "unknown";
          const snippet = ref.content?.text?.slice(0, 200) ?? "(no text)";
          console.log(`  Source: ${uri}`);
          console.log(`  Snippet: ${snippet}...`);
          console.log();
        }
      }
    } else {
      console.log("\n(No citations returned — KB may not have matching documents)");
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError querying Knowledge Base: ${message}`);

  if (message.includes("AccessDenied") || message.includes("not authorized")) {
    console.error("\nThe AWS IAM user does not have permission to query this Knowledge Base.");
    console.error("Required permissions: bedrock:RetrieveAndGenerate, bedrock:Retrieve");
  }

  process.exit(1);
}
