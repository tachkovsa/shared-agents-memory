import type { Config } from './config.js';

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export class EmbeddingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly expectedDimension: number;

  constructor(config: Config) {
    this.apiKey = config.openRouter.apiKey;
    this.baseUrl = config.openRouter.baseUrl;
    this.model = config.openRouter.model;
    this.expectedDimension = config.openRouter.embeddingDimension;
  }

  /**
   * Generate an embedding vector for the given text.
   * Validates the returned dimension matches the expected 4096.
   */
  async embed(input: string): Promise<number[]> {
    const vectors = await this.embedBatch([input]);
    return vectors[0];
  }

  /**
   * Generate embeddings for multiple inputs in a single request.
   */
  async embedBatch(inputs: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new EmbeddingError(
        `OpenRouter embedding request failed (${response.status}): ${body}`,
        response.status,
      );
    }

    const result = (await response.json()) as EmbeddingResponse;

    for (const item of result.data) {
      if (item.embedding.length !== this.expectedDimension) {
        throw new EmbeddingError(
          `Dimension mismatch: got ${item.embedding.length}, expected ${this.expectedDimension}`,
        );
      }
    }

    return result.data.map((d) => d.embedding);
  }
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }

  get isRetryable(): boolean {
    return (
      this.statusCode !== undefined &&
      [429, 502, 503].includes(this.statusCode)
    );
  }
}
