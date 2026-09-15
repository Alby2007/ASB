import type { MessageEvent } from "./types.js";

// Cheap, conservative pre-filter: it prevents an LLM request for ordinary chatter.
const durableSignals = /\b(i (?:really )?(?:love|like|hate|prefer|support|enjoy|work|study|live)|my favourite|i used to|i don't (?:like|support)|remember when|last (?:week|month|year)|always|never|we (?:always|call|joke)|inside joke|incident|birthday|anniversary)\b/i;

export function shouldInspectForMemory(event: MessageEvent) {
  const text = event.content.trim();
  return text.length >= 12 && text.length <= 2_000 && durableSignals.test(text);
}
