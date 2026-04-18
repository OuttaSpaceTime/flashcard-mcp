/**
 * Text similarity and duplicate detection for flashcards.
 *
 * Two-stage approach:
 *  1. Jaccard word-overlap (fast, always available)
 *  2. Cosine similarity on embeddings (semantic, lazy-loaded via transformers.js)
 */

// --- Vector math ---

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

// --- Jaccard ---

export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
  );

  if (wordsA.size === 0 && wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// --- Embedding pipeline (lazy-loaded) ---

let embeddingPipeline: ((text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>) | null = null;
let loadingPromise: Promise<void> | null = null;

export function isEmbeddingsReady(): boolean {
  return embeddingPipeline != null;
}

export async function initEmbeddings(): Promise<void> {
  if (embeddingPipeline) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      embeddingPipeline = (await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { dtype: "q8" } as Record<string, unknown>
      )) as (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>;
    } catch (err) {
      console.error("Failed to load embedding model:", err);
      embeddingPipeline = null;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!embeddingPipeline) {
    await initEmbeddings();
  }
  if (!embeddingPipeline) return null;

  try {
    const result = await embeddingPipeline(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(result.data as Float32Array);
  } catch {
    return null;
  }
}

// --- Similarity search ---

export interface SimilarCard {
  id: string;
  front: string;
  similarity: number;
}

export interface CardForSimilarity {
  id: string;
  front: string;
  embedding: string | null;
}

export interface SemanticOptions {
  queryEmbedding: number[];
  cosineThreshold: number;
}

export function findSimilarCards(
  newFront: string,
  existingCards: CardForSimilarity[],
  jaccardThreshold: number = 0.65,
  semantic?: SemanticOptions
): SimilarCard[] {
  const resultMap = new Map<string, SimilarCard>();

  // Stage 1: Jaccard
  for (const card of existingCards) {
    const sim = jaccardSimilarity(newFront, card.front);
    if (sim >= jaccardThreshold) {
      const existing = resultMap.get(card.id);
      if (!existing || sim > existing.similarity) {
        resultMap.set(card.id, { id: card.id, front: card.front, similarity: sim });
      }
    }
  }

  // Stage 2: Cosine similarity on embeddings (if available)
  if (semantic) {
    for (const card of existingCards) {
      if (!card.embedding) continue;

      let cardEmb: number[];
      try {
        cardEmb = JSON.parse(card.embedding);
      } catch {
        continue;
      }

      const sim = cosineSimilarity(semantic.queryEmbedding, cardEmb);
      if (sim >= semantic.cosineThreshold) {
        const existing = resultMap.get(card.id);
        if (!existing || sim > existing.similarity) {
          resultMap.set(card.id, { id: card.id, front: card.front, similarity: sim });
        }
      }
    }
  }

  return Array.from(resultMap.values()).sort((a, b) => b.similarity - a.similarity);
}

// --- Duplicate check (combines both stages) ---

export function checkDuplicate(
  newFront: string,
  existingCards: CardForSimilarity[],
  duplicateThreshold: number = 0.85,
  warningThreshold: number = 0.65,
  semantic?: SemanticOptions
): {
  isDuplicate: boolean;
  reason?: string;
  similarCards: SimilarCard[];
} {
  const similar = findSimilarCards(
    newFront,
    existingCards,
    warningThreshold,
    semantic
  );

  const duplicates = similar.filter((c) => c.similarity >= duplicateThreshold);
  if (duplicates.length > 0) {
    return {
      isDuplicate: true,
      reason: `Near-duplicate of "${duplicates[0].front}" (${(duplicates[0].similarity * 100).toFixed(0)}% match)`,
      similarCards: similar,
    };
  }

  if (similar.length > 0) {
    return {
      isDuplicate: false,
      reason: `Similar cards exist: "${similar[0].front}" (${(similar[0].similarity * 100).toFixed(0)}% match)`,
      similarCards: similar,
    };
  }

  return { isDuplicate: false, similarCards: [] };
}
