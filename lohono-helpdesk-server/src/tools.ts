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

// ── Zod schema ────────────────────────────────────────────────────────────

const QueryKnowledgeBaseInputSchema = z.object({
  question: z.string().min(1, "Question cannot be empty"),
});

// ── Tool definitions (JSON Schema for MCP) ────────────────────────────────

export const toolDefinitions = [
  {
    name: "query_knowledge_base",
    description:
      "Search the Lohono Stays / Isprava help desk knowledge base for answers about policies, procedures, SOPs, villa information, guest guidelines, and operational documentation. Use this tool when users ask about company policies, operational procedures, property details, or any non-data/non-metric questions.",
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
      let citationText = "";
      if (citations.length > 0) {
        const sources: string[] = [];
        for (const citation of citations) {
          for (const ref of citation.retrievedReferences || []) {
            const uri = ref.location?.s3Location?.uri;
            if (uri && !sources.includes(uri)) {
              sources.push(uri);
            }
          }
        }
        if (sources.length > 0) {
          citationText = "\n\nSources:\n" + sources.map((s) => `- ${s}`).join("\n");
        }
      }

      return {
        content: [{ type: "text", text: answerText + citationText }],
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
