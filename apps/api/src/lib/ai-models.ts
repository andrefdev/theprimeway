import { deepseek } from '@ai-sdk/deepseek'
import { openai } from '@ai-sdk/openai'
import type { EmbeddingModel, LanguageModel } from 'ai'

export const chatModel: LanguageModel = deepseek('deepseek-chat')

// Multimodal model used when the user attaches images. DeepSeek-chat is text-only.
export const visionModel: LanguageModel = openai('gpt-4o-mini')

export const taskModel: LanguageModel = deepseek('deepseek-chat')

export const fastModel: LanguageModel = deepseek('deepseek-chat')

// Embeddings — only used by the brain concept graph pipeline. text-embedding-3-small
// is 1536-dim, ~$0.02/1M tokens, and matches the pgvector column dimension on
// brain_concepts.embedding / brain_clusters.centroid_embedding.
export const embeddingModel: EmbeddingModel<string> = openai.textEmbeddingModel(
  'text-embedding-3-small',
)
