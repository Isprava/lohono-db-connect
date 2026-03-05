/**
 * Embedding generation using @xenova/transformers with all-MiniLM-L6-v2.
 *
 * Lazy-loads the model on first use (~80MB, loads in ~2-3s).
 * Subsequent calls use the cached pipeline (~5-20ms per embedding).
 *
 * Docker note: The Alpine container needs `gcompat libstdc++` packages
 * for onnxruntime-node to load. See Dockerfile.
 */

import { logger } from "../../shared/observability/src/logger.js";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

// ── Singleton pipeline ──────────────────────────────────────────────────────

let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;

async function getPipeline() {
  if (pipelineInstance) return pipelineInstance;

  // Prevent multiple concurrent loads
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const start = Date.now();
    logger.info(`Loading embedding model: ${EMBEDDING_MODEL}`);

    const { pipeline } = await import("@xenova/transformers");
    pipelineInstance = await pipeline("feature-extraction", EMBEDDING_MODEL);

    const elapsed = Date.now() - start;
    logger.info(`Embedding model loaded in ${elapsed}ms`);
    return pipelineInstance;
  })();

  return loadingPromise;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a normalized embedding vector for a single text string.
 * Returns a plain number[] of length EMBEDDING_DIMENSIONS (384).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const start = Date.now();

  const output = await pipe(text, { pooling: "mean", normalize: true });
  const vector = Array.from(output.data as Float32Array).slice(0, EMBEDDING_DIMENSIONS);

  logger.debug(`Embedding generated in ${Date.now() - start}ms`, {
    textLength: text.length,
    dimensions: vector.length,
  });

  return vector;
}

/**
 * Generate normalized embedding vectors for multiple texts.
 * Processes sequentially to avoid memory spikes (model is single-threaded).
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text));
  }
  return results;
}
