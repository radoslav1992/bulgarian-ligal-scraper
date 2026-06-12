import type { Env } from '../types';

/**
 * BAAI BGE-M3 — multilingual embedding model on Workers AI, 1024 dimensions.
 * Handles Bulgarian well; the Vectorize index must be created with
 * --dimensions=1024 --metric=cosine.
 */
const EMBEDDING_MODEL = '@cf/baai/bge-m3';

/** Texts per Workers AI call; conservative to stay well under input limits. */
const AI_BATCH_SIZE = 15;

/** BGE-M3 supports long inputs, but retrieval quality is best on short chunks. */
const MAX_INPUT_CHARS = 4000;

interface EmbeddingResponse {
  data: number[][];
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += AI_BATCH_SIZE) {
    const batch = texts.slice(i, i + AI_BATCH_SIZE).map((t) => t.slice(0, MAX_INPUT_CHARS));
    const res = (await env.AI.run(EMBEDDING_MODEL as keyof AiModels, {
      text: batch,
    })) as unknown as EmbeddingResponse;
    if (!res?.data || res.data.length !== batch.length) {
      throw new Error(`Embedding call returned ${res?.data?.length ?? 0} vectors for ${batch.length} inputs`);
    }
    vectors.push(...res.data);
  }
  return vectors;
}

export async function embedQuery(env: Env, query: string): Promise<number[]> {
  const [vector] = await embedTexts(env, [query]);
  if (!vector) throw new Error('Failed to embed query');
  return vector;
}
