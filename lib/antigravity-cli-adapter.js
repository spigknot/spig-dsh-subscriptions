import { groupCliModels, pickCliModel } from './antigravity-cli-catalog.js';

/** Gemini 4 generation window on the Antigravity subscription. */
export const CLI_CONTEXT_WINDOW = 1_048_576;
/** Fallback output cap when a model does not advertise its own. */
export const CLI_DEFAULT_MAX_TOKENS = 32_768;

export function createCliAdapter({ list, run, defaultEffortOf = () => undefined, error = (message) => new Error(message) }) {
  let cache, expires = 0, pending;
  async function models() {
    if (cache && Date.now() < expires) return cache;
    pending ??= Promise.resolve().then(() => list({ signal: AbortSignal.timeout(60000) })).then(rows => {
      cache = groupCliModels(rows);
      expires = Date.now() + 60000;
      return cache;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  // Context capacity is mandatory: compaction and model switching size their
  // budget from it, and an empty context rejects every mid-session switch.
  const info = (provider, id, name) => ({
    provider,
    id,
    name,
    inputModalities: ['text'],
    context: { contextWindow: CLI_CONTEXT_WINDOW },
    defaultMaxTokens: CLI_DEFAULT_MAX_TOKENS
  });
  return {
    clearAccountCatalog() { expires = 0; },
    providerInfo: provider => ({id:provider, name:'Google Antigravity (agy CLI)'}),
    providerRetryPolicy: () => ({mode:'normal', maxRetries:0, retryableCodes:[], initialDelayMs:1000, maxDelayMs:1000, jitterRatio:0}),
    async listModels(provider) {
      return (await models()).map(entry => info(provider, entry.id, entry.name));
    },
    async resolveModel(provider, model, signal) {
      signal?.throwIfAborted();
      const entries = await models();
      signal?.throwIfAborted();
      const entry = entries.find(item => item.id === model || [...item.variants.values()].includes(model));
      if (!entry) throw error(`Model ${model} is not listed by agy models`, 'NO_ADAPTER');
      let reasoning = entry.reasoning;
      if (reasoning && entry.id !== model) {
        const effort = reasoning.efforts.find(effort => entry.variants.get(effort.id) === model);
        reasoning = {efforts:[effort], defaultEffort:effort.id};
      } else if (reasoning) {
        const configured = defaultEffortOf(model);
        if (reasoning.efforts.some(effort => effort.id === configured)) reasoning = {...reasoning,defaultEffort:configured};
      }
      return {...info(provider,model,entry.name), ...(reasoning ? {reasoning} : {})};
    },
    async prepareCall(provider, model, signal) {
      return {model: await this.resolveModel(provider, model, signal),stream: options => this.stream(options)};
    },
    async *stream(options) {
      options.signal?.throwIfAborted();
      const entries = await models();
      options.signal?.throwIfAborted();
      const configured = defaultEffortOf(options.model);
      const entry = entries.find(item => item.id === options.model);
      const effort = options.reasoningEffort ?? entry?.reasoning?.efforts.find(item => item.id === configured)?.id;
      let model;
      try { model = pickCliModel(entries, options.model, effort); }
      catch (cause) { throw error(cause.message, 'NO_ADAPTER'); }
      const result = await run({...options,model});
      const text = typeof result === 'string' ? result : result.text;
      if (!text?.trim()) throw error('Antigravity CLI returned no text', 'EMPTY_RESPONSE');
      yield {type:'block-start', index:0, blockType:'text'};
      yield {type:'text-delta',index:0,text};
      yield {type:'block-end',index:0,block:{type:'text',text}};
      if (result?.usage) yield {type:'usage',usage:result.usage};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  };
}
