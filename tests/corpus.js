/**
 * Classification corpus.
 *
 * Every case states the expected type. The benchmark measures accuracy
 * against this file BEFORE any classifier change, so a "fix" that helps
 * models but breaks keys is visible immediately instead of shipping.
 *
 * Shapes are synthetic. None of these are real credentials.
 */

export const CORPUS = [
  // ---------------------------------------------------------- API keys
  // Known prefixes. These must NEVER be reclassified as models, however
  // much they may look like a structured name.
  { value: 'oc_sk_A1b2C3d4E5f6G7h8I9j0', type: 'API_KEY' },
  { value: 'sk-or-v1-abcdef0123456789abcdef01', type: 'API_KEY' },
  { value: 'sk-proj-abc123def456ghi789jkl012', type: 'API_KEY' },
  { value: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrSt', type: 'API_KEY' },
  { value: 'gsk_AbCdEfGhIjKlMnOpQrStUvWxYz012', type: 'API_KEY' },
  { value: 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2', type: 'API_KEY' },
  { value: 'xai-AbCdEfGhIjKlMnOpQrStUvWx0123', type: 'API_KEY' },
  { value: 'sk-9f8e7d6c5b4a39281706f5e4d3c2b1a', type: 'API_KEY' },

  // Opaque high-entropy blobs with no vendor hint. These are the hard
  // negatives: they look like hyphenated names but carry no word structure.
  { value: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', type: 'API_KEY' },
  { value: '7f3d9a2b1c8e5f4a6d3b9c1e7f2a8d5b', type: 'API_KEY' },
  { value: 'xK9mQ2vB7nL4pR8tY1uI3oP6aS0dF5gH', type: 'API_KEY' },

  // ---------------------------------------------------------------- Models
  // Vendor family prefix.
  { value: 'gpt-4o', type: 'MODEL' },
  { value: 'gpt-4o-mini', type: 'MODEL' },
  { value: 'gpt-4-turbo', type: 'MODEL' },
  { value: 'o1-preview', type: 'MODEL' },
  { value: 'o3-mini-high', type: 'MODEL' },
  { value: 'claude-3-5-sonnet-20241022', type: 'MODEL' },
  { value: 'claude-sonnet-4-20250514', type: 'MODEL' },
  { value: 'gemini-2.0-flash-exp', type: 'MODEL' },
  { value: 'gemini-2.5-pro-preview-05-06', type: 'MODEL' },
  { value: 'command-r-plus', type: 'MODEL' },
  { value: 'mistral-large-2407', type: 'MODEL' },
  { value: 'mixtral-8x7b-instruct', type: 'MODEL' },
  { value: 'qwen2.5-coder-32b-instruct', type: 'MODEL' },
  { value: 'deepseek-r1-distill-qwen-32b', type: 'MODEL' },
  { value: 'deepseek-chat-v3', type: 'MODEL' },
  { value: 'llama-3.3-70b-instruct', type: 'MODEL' },
  { value: 'gemma-2-9b-it', type: 'MODEL' },
  { value: 'phi-3.5-mini-instruct', type: 'MODEL' },
  { value: 'glm-4-plus', type: 'MODEL' },
  { value: 'kimi-k2-0711-preview', type: 'MODEL' },
  { value: 'grok-2-latest', type: 'MODEL' },

  // Provider-specific free tiers named in the plan.
  { value: 'space-bunny-free', type: 'MODEL' },
  { value: 'fledge-alpha-free', type: 'MODEL' },
  { value: 'nemotron-free', type: 'MODEL' },

  // Dated / versioned names. These are the cases that were misread as keys.
  { value: 'gpt-4o-2024-08-06-preview', type: 'MODEL' },
  { value: 'claude-3-5-sonnet-20241022', type: 'MODEL' },
  { value: 'gemini-1.5-pro-002', type: 'MODEL' },
  { value: 'mistral-large-2407-v1', type: 'MODEL' },
  { value: 'command-r-08-2024', type: 'MODEL' },
  { value: 'meta-llama-3.1-405b-instruct', type: 'MODEL' },

  // Open-weight repo paths with a size in the name.
  { value: 'nvidia/Llama-3.1-Nemotron-70B-Instruct-HF', type: 'MODEL' },
  { value: 'meta-llama/Llama-3.3-70B-Instruct', type: 'MODEL' },
  { value: 'TheBloke/Llama-2-13B-GGUF', type: 'MODEL' },
  { value: 'deepseek-ai/DeepSeek-V3', type: 'MODEL' },
  { value: 'Qwen/Qwen2.5-72B-Instruct', type: 'MODEL' },

  // Quantisation / precision suffixes.
  { value: 'Qwen2.5-Coder-32B-Instruct-AWQ', type: 'MODEL' },
  { value: 'llama-3-70b-instruct-bf16', type: 'MODEL' },
  { value: 'mistral-7b-instruct-v0.2-q4_k_m', type: 'MODEL' },
  { value: 'phi-3-medium-128k-instruct-fp8', type: 'MODEL' },
  { value: 'gemma-2-27b-it-int8', type: 'MODEL' },

  // ------------------------------------------------------------------ URLs
  { value: 'https://api.openai.com/v1', type: 'URL' },
  { value: 'https://opencode.ai/zen/v1/', type: 'URL' },
  { value: 'https://openrouter.ai/api/v1', type: 'URL' },
  { value: 'api.anthropic.com', type: 'URL' },
  { value: 'https://api.groq.com/openai/v1', type: 'URL' },

  // -------------------------------------------------------------- Unknown

  // ------------------------------------------- adversarial / near-miss cases
  // Keys that contain words AND separators, so a naive "has separators"
  // model rule would swallow them.
  { value: 'sk-proj-T1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6', type: 'API_KEY' },
  { value: 'sk-or-v1-aa11bb22cc33dd44ee55ff66gg77hh88', type: 'API_KEY' },
  { value: 'oc_sk_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz', type: 'API_KEY' },

  // Models that look like keys by length and digit count.
  { value: 'gpt-4.1-2025-04-14', type: 'MODEL' },
  { value: 'claude-opus-4-1-20250805', type: 'MODEL' },
  { value: 'deepseek-v3-0324', type: 'MODEL' },
  { value: 'qwen3-235b-a22b-instruct-2507', type: 'MODEL' },

  // Hostnames that look like model names (must stay URL).
  { value: 'api.anthropic.com', type: 'URL' },
  { value: 'gateway.ai.cloudflare.com', type: 'URL' },
  { value: 'models.dev', type: 'URL' },

  { value: 'hello world', type: 'UNKNOWN' },
  { value: '1.2.3', type: 'UNKNOWN' },
  { value: '', type: 'UNKNOWN' },
  { value: '   ', type: 'UNKNOWN' },
  { value: 'some totally unknown content', type: 'UNKNOWN' },
];

/** Expected count per type, used to sanity-check the corpus itself. */
export function corpusStats() {
  const stats = {};
  for (const item of CORPUS) {
    stats[item.type] = (stats[item.type] ?? 0) + 1;
  }
  return stats;
}
