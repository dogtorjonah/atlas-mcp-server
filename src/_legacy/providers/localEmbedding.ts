function notConfigured(message: string): never {
  throw new Error(message);
}

export interface LocalEmbeddingProvider {
  embedText(text: string): Promise<number[]>;
}

export function createLocalEmbeddingProvider(): LocalEmbeddingProvider {
  return {
    async embedText(): Promise<never> {
      notConfigured('Local embedding provider scaffold is present but not yet wired');
    },
  };
}
