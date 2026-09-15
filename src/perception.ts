import type { MessageEvent } from "./types.js";

// Cheap, conservative pre-filter: it prevents an LLM request for ordinary chatter.
const durableSignals = /\b(i (?:really )?(?:love|like|hate|prefer|support|enjoy|work|study|live|am|was|do|did|went|grew up|moved|moved to|have|had|got|play|played|watch|watched|read|reading|listen|listening)|my (?:favourite|favorite|job|work|wife|husband|partner|girlfriend|boyfriend|mum|mom|dad|sister|brother|house|flat|apartment|car|degree|school|college|uni|university|company|firm|boss)|i (?:used to|don't|do not|can't|cannot|won't|will not|never|always)|i'm (?:a|an|from|in|at|doing|working|studying|living|moving)|remember when|last (?:week|month|year|night|time)|we (?:always|call|joke|went|did)|inside joke|incident|birthday|anniversary|got (?:a|an|my|this)|been (?:to|at|working|doing|living)|she (?:is|was|does|did|has|said)|he (?:is|was|does|did|has|said)|they (?:are|were|do|did|have|said)|years? ago|since i was|growing up|as a kid|in school|at work|at uni|at college)\b/i;

export function shouldInspectForMemory(event: MessageEvent) {
  const text = event.content.trim();
  return text.length >= 12 && text.length <= 2_000 && durableSignals.test(text);
}
