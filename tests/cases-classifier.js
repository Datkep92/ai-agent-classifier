import { describe, it, assert, assertEqual } from './harness.js';
import { classifyItem, ITEM_TYPE } from '../core/classifier.js';
import { CORPUS } from './corpus.js';

const typeOf = (value) => classifyItem(value).type;

export function registerClassifierCases() {
  describe('CL. Structural model-vs-key discrimination', () => {
    it('CL1: a model id carries a word-like segment, a key does not', () => {
      // The structural discriminator: every real model id contains an
      // alphabetic segment of 3+ characters, while key material does not.
      for (const item of CORPUS.filter((c) => c.type === 'MODEL')) {
        assertEqual(typeOf(item.value), ITEM_TYPE.MODEL, `model misread: ${item.value}`);
      }
    });

    it('CL2: key material is never reclassified as a model', () => {
      // The regression that matters most: the corpus deliberately includes
      // keys that contain words AND separators, so a naive "has separators"
      // model rule would swallow them.
      for (const item of CORPUS.filter((c) => c.type === 'API_KEY')) {
        assertEqual(typeOf(item.value), ITEM_TYPE.API_KEY, `key misread: ${item.value}`);
      }
    });

    it('CL3: a dotted version tail is not a hostname', () => {
      // "gemini-2.0-flash-exp" has dots, but a TLD is letters. A hostname's
      // last dotted label must be alphabetic; a model's may be numeric.
      for (const value of [
        'gemini-2.0-flash-exp',
        'qwen2.5-coder-32b-instruct',
        'phi-3.5-mini-instruct',
        'llama-3.3-70b-instruct',
        'gpt-4.1-2025-04-14',
        'gemini-1.5-pro-002',
        'meta-llama-3.1-405b-instruct',
        'Qwen2.5-Coder-32B-Instruct-AWQ',
        'mistral-7b-instruct-v0.2-q4_k_m',
      ]) {
        assertEqual(typeOf(value), ITEM_TYPE.MODEL, `dotted model misread: ${value}`);
      }
    });

    it('CL4: a real hostname keeps its last alphabetic label', () => {
      for (const value of [
        'api.anthropic.com',
        'models.dev',
        'gateway.ai.cloudflare.com',
        'https://openrouter.ai/api/v1',
      ]) {
        assertEqual(typeOf(value), ITEM_TYPE.URL, `hostname misread: ${value}`);
      }
    });

    it('CL5: an open-weight repo path is a model, not a URL', () => {
      // HuggingFace-style paths carry a vendor org segment and a real model
      // name after the slash, and are routinely served by /models endpoints.
      for (const value of [
        'nvidia/Llama-3.1-Nemotron-70B-Instruct-HF',
        'meta-llama/Llama-3.3-70B-Instruct',
        'TheBloke/Llama-2-13B-GGUF',
        'Qwen/Qwen2.5-72B-Instruct',
        'deepseek-ai/DeepSeek-V3',
      ]) {
        assertEqual(typeOf(value), ITEM_TYPE.MODEL, `repo path misread: ${value}`);
      }
    });

    it('CL6: a key prefix wins even when the payload looks model-shaped', () => {
      // These keys contain readable words AND separators. Structural
      // similarity to a model id must not override a known prefix.
      for (const value of [
        'sk-proj-T1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6',
        'sk-or-v1-aa11bb22cc33dd44ee55ff66gg77hh88',
        'oc_sk_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz',
      ]) {
        assertEqual(typeOf(value), ITEM_TYPE.API_KEY, `prefixed key misread: ${value}`);
      }
    });

    it('CL7: prose and empty input stay UNKNOWN', () => {
      for (const value of ['', '   ', 'hello world', 'some totally unknown content']) {
        assertEqual(typeOf(value), ITEM_TYPE.UNKNOWN, `prose misread: "${value}"`);
      }
    });

    it('CL8: a bare version number is not a host and not a model', () => {
      assertEqual(typeOf('1.2.3'), ITEM_TYPE.UNKNOWN, 'version number');
    });

    it('CL9: the whole corpus classifies exactly as labelled', () => {
      const wrong = CORPUS.filter((item) => typeOf(item.value) !== item.type).map((item) => ({
        value: item.value,
        expected: item.type,
        got: typeOf(item.value),
      }));
      assertEqual(wrong.length, 0, 'mismatches: ' + JSON.stringify(wrong));
    });

    it('CL10: a lab/api-key decision never leaks the secret into the reason', () => {
      const secret = 'sk-proj-T1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
      const result = classifyItem(secret);
      assertEqual(result.type, ITEM_TYPE.API_KEY, 'is a key');
      assert(!String(result.reason).includes(secret), 'reason does not echo the secret');
    });
  });
}

/**
 * Held-out cases: values that are NOT in tests/corpus.js.
 *
 * The corpus benchmark can reach 100% by memorisation. These were written
 * after the rules were designed and cover vendor prefixes the corpus does
 * not contain, so a future change that only "fixes the corpus" is caught.
 */
const HELD_OUT = {
  MODEL: [
    'claude-3-opus-20240229', 'claude-3-haiku-20240307', 'gemini-1.5-flash-8b',
    'gpt-4o-mini-2024-07-18', 'gpt-3.5-turbo-0125', 'o1-mini-2024-09-12',
    'llama-3.1-8b-instruct', 'llama-3.2-90b-vision-instruct', 'mixtral-8x22b-instruct-v0.1',
    'mistral-nemo-12b-instruct-2407', 'command-r-35b-10-2024', 'qwen-max-2025-01-25',
    'qwen2-vl-7b-instruct', 'glm-4v-plus-0111', 'kimi-latest', 'grok-beta',
    'nemotron-4-340b-instruct', 'deepseek-chat-0324', 'phi-4-14b-instruct',
    'gemma-3-27b-it', 'codestral-latest', 'sonar-pro', 'deepinfra/llama-3.3-70b',
    'tinyllama-1.1b-chat-v1.0', 'stablelm-zephyr-3b', 'openchat-3.5-0106',
    'nous-hermes-2-mixtral-8x7b-dpo', 'gpt-4-turbo-preview', 'text-embedding-3-large',
    'whisper-1', 'tts-1-hd', 'dall-e-3', 'omni-moderation-latest',
  ],
  API_KEY: [
    'sk-proj-Examplefixture0123456789',
    'sk-ant-api03-Examplefixture0123',
    'ghp_Examplefixture0123456789abcdef0123',
    'glpat-EXAMPLEfixture01',
    'hf_Examplefixture01234',
    'r8_Examplefixture0123456789',
    'AKIAEXAMPLEFIXTURE01',
    'sk_live_EXAMPLEfixture1',
    'pk_live_EXAMPLEfixture1',
    'nvapi-EXAMPLEfixture01',
    'aW52YWxpZC1maXh0dXJlLXNlY3JldC1ub3QtcmVhbC1wYXlsb2Fk',
  ],
  URL: [
    'https://api.groq.com/openai/v1', 'api.together.xyz', 'https://openrouter.ai/api/v1',
    'my-gateway.fly.dev', 'https://api.deepseek.com/v1', 'openrouter.ai',
  ],
  UNKNOWN: [
    'hello world', 'some totally unknown content', 'what is this',
    'my api key is broken',
  ],
};

export function registerHeldOutCases() {
  describe('CL2. Held-out cases absent from the corpus', () => {
    for (const [type, values] of Object.entries(HELD_OUT)) {
      it(`CL2:${type}: every held-out ${type} is classified correctly`, () => {
        const wrong = values.filter((v) => typeOf(v) !== type).map((v) => ({
          value: v.slice(0, 40),
          got: typeOf(v),
        }));
        assertEqual(wrong.length, 0, `mismatches: ${JSON.stringify(wrong)}`);
      });
    }

    it('CL2: non-LLM vendor keys are not mistaken for model names', () => {
      // Payloads here are fixtures. The GitLab one is deliberately shorter
      // than a real token so GitHub push protection does not flag the file.
      // These payloads contain readable letter runs ("ghp", "glpat", "live")
      // and are indistinguishable from a model id by shape alone. Only the
      // documented prefix identifies them, so the prefix table must cover
      // vendors outside the LLM world.
      for (const value of [
        'ghp_Examplefixture0123456789abcdef0123',
        'glpat-EXAMPLEfixture01',
        'sk_live_EXAMPLEfixture1',
        'pk_live_EXAMPLEfixture1',
        'hf_Examplefixture01234',
      ]) {
        assertEqual(typeOf(value), ITEM_TYPE.API_KEY, `vendor key misread: ${value}`);
      }
    });

    it('CL2: an opaque blob with no separators is a key, never a model', () => {
      // Prefix-free keys cannot be caught by the prefix table. The structural
      // fallback is composition: a model id always has a separator.
      for (const value of [
        'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        '7f3d9a2b1c8e5f4a6d3b9c1e7f2a8d5b',
        'xK9mQ2vB7nL4pR8tY1uI3oP6aS0dF5gH',
      ]) {
        assertEqual(typeOf(value), ITEM_TYPE.API_KEY, `blob misread: ${value}`);
      }
    });
  });
}
