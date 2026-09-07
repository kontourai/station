const MODEL_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  google: 'Google',
  lancedb: 'Built-in vector store',
  ollama: 'Ollama',
  'openai-compat': 'OpenAI-Compatible',
};

/** Model/knowledge connection vocabulary; this does not name engines. */
export function modelProviderDisplayLabel(type: string): string {
  return MODEL_PROVIDER_LABELS[type] ?? type;
}
