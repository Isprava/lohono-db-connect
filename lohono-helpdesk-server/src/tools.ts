import { z } from "zod";
import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { logger } from "../../shared/observability/src/logger.js";

// ── Bedrock client ────────────────────────────────────────────────────────

const AWS_REGION = process.env.AWS_REGION || "ap-south-1";
const KNOWLEDGE_BASE_ID = process.env.BEDROCK_KB_ID || "";
const MODEL_ARN =
  process.env.BEDROCK_MODEL_ARN ||
  `arn:aws:bedrock:${AWS_REGION}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`;

const bedrockClient = new BedrockAgentRuntimeClient({
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

// ── Debug mode ───────────────────────────────────────────────────────────

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

// ── Zod schema ────────────────────────────────────────────────────────────

const QueryKnowledgeBaseInputSchema = z.object({
  question: z.string().min(1, "Question cannot be empty"),
});

// ── Tool definitions (JSON Schema for MCP) ────────────────────────────────

export const toolDefinitions = [
  {
    name: "query_knowledge_base",
    description:
      "Search the Lohono Stays / Isprava help desk knowledge base for answers about policies, procedures, SOPs, villa information, guest guidelines, operational documentation, and Goa building/construction regulations (Goa DCR — the Goa Regulation of Land Development and Building Construction Act 2008, and the Goa Land Development and Building Construction Regulations 2010, with amendments up to September 2024). Use this tool for: company policies, operational procedures, property details, non-data/non-metric questions, FAR/FSI, setbacks, zoning regulations, parking requirements, fire safety, building heights, plot coverage, sub-division rules, and any Goa-specific construction or land development regulation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description:
            "The natural language question to search the knowledge base for",
        },
      },
      required: ["question"],
    },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    if (name === "query_knowledge_base") {
      const { question } = QueryKnowledgeBaseInputSchema.parse(args);
      const startTime = Date.now();

      if (!KNOWLEDGE_BASE_ID) {
        return {
          content: [
            {
              type: "text",
              text: "Error: BEDROCK_KB_ID environment variable is not configured",
            },
          ],
          isError: true,
        };
      }

      logger.info("Querying Bedrock Knowledge Base", {
        kb_id: KNOWLEDGE_BASE_ID,
        question_length: String(question.length),
      });

      const command = new RetrieveAndGenerateCommand({
        input: { text: question },
        retrieveAndGenerateConfiguration: {
          type: "KNOWLEDGE_BASE",
          knowledgeBaseConfiguration: {
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            modelArn: MODEL_ARN,
          },
        },
      });

      const response = await bedrockClient.send(command);
      const answerText = response.output?.text || "No answer found.";

      // Format citations if available
      const citations = response.citations || [];
      const citationSources: string[] = [];
      let citationText = "";
      if (citations.length > 0) {
        for (const citation of citations) {
          for (const ref of citation.retrievedReferences || []) {
            const uri = ref.location?.s3Location?.uri;
            if (uri && !citationSources.includes(uri)) {
              citationSources.push(uri);
            }
          }
        }
        if (citationSources.length > 0) {
          citationText = "\n\nSources:\n" + citationSources.map((s) => `- ${s}`).join("\n");
        }
      }

      let resultText = answerText + citationText;

      if (DEBUG_MODE) {
        const debugInfo = {
          _debug: {
            tool: "query_knowledge_base",
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            modelArn: MODEL_ARN,
            question,
            citationSources,
            executionMs: Date.now() - startTime,
          },
        };
        resultText += "\n\n<!-- DEBUG_JSON:" + JSON.stringify(debugInfo) + " -->";
      }

      return {
        content: [{ type: "text", text: resultText }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        content: [
          {
            type: "text",
            text: `Validation error: ${error.issues.map((e) => e.message).join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Helpdesk tool error", { error: message, tool: name });

    // Surface IAM/permission errors clearly so they can be diagnosed
    if (message.includes("not authorized") || message.includes("AccessDenied")) {
      return {
        content: [
          {
            type: "text",
            text: `Knowledge base access error: The AWS IAM user does not have permission to query the Bedrock Knowledge Base. Please contact your administrator to grant bedrock:RetrieveAndGenerate permissions.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
