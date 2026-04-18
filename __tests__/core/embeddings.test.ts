import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  jaccardSimilarity,
  cosineSimilarity,
  findSimilarCards,
  isEmbeddingsReady,
} from "../../src/core/embeddings.js";

describe("embeddings", () => {
  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const v = [1, 2, 3, 4, 5];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
    });

    it("returns 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
    });

    it("returns -1 for opposite vectors", () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
    });

    it("returns 0 when either vector is zero", () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });

    it("returns 0 for mismatched lengths", () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });
  });

  describe("jaccardSimilarity", () => {
    it("returns 1 for identical strings", () => {
      expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
    });

    it("returns 0 for completely different strings", () => {
      expect(jaccardSimilarity("hello world", "foo bar")).toBe(0);
    });

    it("is case insensitive", () => {
      expect(jaccardSimilarity("Hello World", "hello world")).toBe(1);
    });

    it("returns 0 for empty strings", () => {
      expect(jaccardSimilarity("", "")).toBe(0);
    });
  });

  describe("findSimilarCards (Jaccard only, no embeddings loaded)", () => {
    it("finds exact text duplicates", () => {
      const cards = [
        { id: "1", front: "What is a closure?", embedding: null },
        { id: "2", front: "What is a variable?", embedding: null },
      ];

      const results = findSimilarCards("What is a closure?", cards, 0.65);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("1");
      expect(results[0].similarity).toBe(1);
    });

    it("returns empty for completely different text", () => {
      const cards = [{ id: "1", front: "What is a closure?", embedding: null }];
      const results = findSimilarCards("How does TCP work?", cards, 0.65);
      expect(results.length).toBe(0);
    });

    it("sorts by similarity descending", () => {
      const cards = [
        { id: "1", front: "What is a variable?", embedding: null },
        { id: "2", front: "What is a closure?", embedding: null },
        { id: "3", front: "What is a closure in JS?", embedding: null },
      ];

      const results = findSimilarCards("What is a closure?", cards, 0.3);
      expect(results[0].id).toBe("2");
    });
  });

  describe("findSimilarCards (with pre-computed embeddings)", () => {
    // Use simple known vectors to test the cosine path
    // These simulate cards that are semantically similar but have different words

    it("catches semantic duplicates via embeddings when Jaccard misses", () => {
      // "What is a closure?" and "How do functions capture scope?"
      // share no words (Jaccard = 0) but are semantically similar
      const closureEmb = [0.9, 0.1, 0.0, 0.1]; // similar direction
      const scopeEmb = [0.85, 0.15, 0.05, 0.1]; // similar direction
      const tcpEmb = [0.0, 0.1, 0.9, 0.1]; // very different direction

      const cards = [
        {
          id: "1",
          front: "What is a closure?",
          embedding: JSON.stringify(closureEmb),
        },
        {
          id: "2",
          front: "How does TCP work?",
          embedding: JSON.stringify(tcpEmb),
        },
      ];

      // This text has zero Jaccard overlap with "What is a closure?"
      // but its embedding is similar
      const results = findSimilarCards(
        "How do functions capture scope?",
        cards,
        0.65,
        { queryEmbedding: scopeEmb, cosineThreshold: 0.70 }
      );

      // Should find "closure" card via cosine similarity
      expect(results.some((r) => r.id === "1")).toBe(true);
      // Should NOT find "TCP" card
      expect(results.some((r) => r.id === "2")).toBe(false);
    });

    it("deduplicates when both Jaccard and cosine match the same card", () => {
      const emb = [1, 0, 0, 0];
      const cards = [
        {
          id: "1",
          front: "What is a closure?",
          embedding: JSON.stringify(emb),
        },
      ];

      const results = findSimilarCards(
        "What is a closure?",
        cards,
        0.65,
        { queryEmbedding: emb, cosineThreshold: 0.70 }
      );

      // Should appear only once despite matching both ways
      expect(results.filter((r) => r.id === "1").length).toBe(1);
      // Similarity should be the max of the two
      expect(results[0].similarity).toBe(1);
    });

    it("skips cosine for cards without embeddings", () => {
      const emb = [0.9, 0.1, 0.0, 0.1];
      const cards = [
        { id: "1", front: "What is a closure?", embedding: null }, // no embedding
        {
          id: "2",
          front: "How does TCP work?",
          embedding: JSON.stringify([0.0, 0.1, 0.9, 0.1]),
        },
      ];

      // Query has an embedding but card "1" doesn't
      const results = findSimilarCards(
        "totally different words",
        cards,
        0.65,
        { queryEmbedding: emb, cosineThreshold: 0.70 }
      );

      // Neither should match: "1" has no embedding, "2" is orthogonal
      expect(results.length).toBe(0);
    });
  });

  describe("isEmbeddingsReady", () => {
    it("returns false before model is loaded", () => {
      expect(isEmbeddingsReady()).toBe(false);
    });
  });
});
