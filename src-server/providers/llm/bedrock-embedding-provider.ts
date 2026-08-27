import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { BedrockAuthMode } from './bedrock-credentials.js';
import { bedrockClientAuth } from './bedrock-credentials.js';
import type { IEmbeddingProvider } from './model-provider-types.js';

export interface BedrockEmbeddingProviderConfig {
  region?: string;
  embeddingModel?: string;
  authMode?: BedrockAuthMode;
  profile?: string;
  apiKey?: string;
}

export class BedrockEmbeddingProvider implements IEmbeddingProvider {
  readonly id = 'bedrock-embedding';
  readonly displayName = 'Bedrock Embeddings (Titan V2)';
  private region: string;
  private model: string;
  private authMode: BedrockAuthMode;
  private profile?: string;
  private apiKey?: string;

  constructor({
    region = '',
    embeddingModel = 'amazon.titan-embed-text-v2:0',
    authMode = 'chain',
    profile,
    apiKey,
  }: BedrockEmbeddingProviderConfig = {}) {
    this.region = region;
    this.model = embeddingModel;
    this.authMode = authMode;
    this.profile = profile;
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    );
    const client = new BedrockRuntimeClient({
      region: this.region || undefined,
      ...bedrockClientAuth({
        authMode: this.authMode,
        profile: this.profile,
        apiKey: this.apiKey,
      }),
    });

    const results: number[][] = [];
    for (const text of texts) {
      const command = new InvokeModelCommand({
        modelId: this.model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: text,
          dimensions: 1024,
          normalize: true,
        }),
      });
      const response = await client.send(command);
      const body = JSON.parse(new TextDecoder().decode(response.body));
      results.push(body.embedding);
    }
    return results;
  }

  dimensions(): number {
    return 1024;
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (this.authMode === 'api-key') {
        return Boolean(this.apiKey?.trim());
      }
      const creds =
        this.authMode === 'profile' && this.profile
          ? fromIni({ profile: this.profile })
          : fromNodeProviderChain();
      await creds();
      return true;
    } catch {
      return false;
    }
  }

  async getPrerequisites(): Promise<
    import('@kontourai/station-contracts/tool').Prerequisite[]
  > {
    const hasCreds = await this.healthCheck();
    return [
      {
        id: 'bedrock',
        name: 'Bedrock Credentials',
        description: 'AWS credentials with Bedrock model access',
        status: hasCreds ? 'installed' : 'missing',
        category: 'required',
        installGuide: {
          steps: ['Configure AWS credentials with Bedrock access'],
          links: [
            'https://docs.aws.amazon.com/bedrock/latest/userguide/setting-up.html',
          ],
        },
      },
    ];
  }
}
