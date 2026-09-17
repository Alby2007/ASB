import type { MessageEvent } from "./types.js";

// Cheap, conservative pre-filter: it prevents an LLM request for ordinary chatter.
// The naming/preference stems (call me, my name is, i go by, pronouns…) cover the
// durable classes the original list missed; the periodic LLM triage sweep is the
// real safety net for everything else, so this stays bounded rather than
// comprehensive.
const durableSignals = /\b(i (?:really )?(?:love|like|hate|prefer|support|enjoy|work|study|live|am|was|do|did|went|grew up|moved|moved to|have|had|got|play|played|watch|watched|read|reading|listen|listening)|my (?:favourite|favorite|job|work|wife|husband|partner|girlfriend|boyfriend|mum|mom|dad|sister|brother|house|flat|apartment|car|degree|school|college|uni|university|company|firm|boss)|i (?:used to|don't|do not|can't|cannot|won't|will not|never|always)|i'm (?:a|an|from|in|at|doing|working|studying|living|moving)|remember when|last (?:week|month|year|night|time)|we (?:always|call|joke|went|did)|inside joke|incident|birthday|anniversary|got (?:a|an|my|this)|been (?:to|at|working|doing|living)|she (?:is|was|does|did|has|said)|he (?:is|was|does|did|has|said)|they (?:are|were|do|did|have|said)|years? ago|since i was|growing up|as a kid|in school|at work|at uni|at college|call me|my name is|my name'?s|i go by|prefer to be called|refer to me as|don'?t call me|my pronouns?|reminds? me of|i can't stand)\b/i;

export function shouldInspectForMemory(event: MessageEvent) {
  const text = event.content.trim();
  if (text.length < 12 || text.length > 2_000) return false;
  // Bot-addressed messages always get inspected — the reply path is already an
  // LLM call, and direct requests ("remember this", "call me X") are durable.
  return event.mentionsBot || durableSignals.test(text);
}

// ── Provenance guards ─────────────────────────────────────────────────────────

// "I am <Capitalized Name>" where the name is not one of the author's own names is
// the signature of pasted/echoed text ("I am Sage, a dragon lover…") or persona
// play — the claim belongs to the named person, not the poster. Requiring a
// capitalized token keeps "i am depressed/tired/cooked" from firing; the
// stopword list covers common capitalized openers ("I am Not", "I am The").
const selfNaming = /(?:^|\W)[iI](?:'|’)m\s+(?:actually\s+|literally\s+)?([A-Z][\w'.-]*)|(?:^|\W)[iI]\s+am\s+(?:actually\s+|literally\s+)?([A-Z][\w'.-]*)/;
const selfNamingStopwords = new Set([
  "the", "a", "an", "not", "so", "just", "actually", "literally", "currently", "really",
  "very", "too", "also", "still", "only", "always", "never", "now", "here", "there",
  "done", "cooked", "dead", "dying", "fine", "ok", "okay", "good", "bad", "sorry",
  "sure", "right", "wrong", "back", "home", "online", "offline", "new", "old", "this",
  "that", "your", "my", "his", "her", "their", "our", "being", "gonna", "going",
]);

function validLearnedName(name: string | undefined, authorNames: string[]): string | undefined {
  const cleaned = name?.replace(/[.]+$/, "");
  if (!cleaned || selfNamingStopwords.has(cleaned.toLowerCase())) return undefined;
  // All-caps words are emphasis ("i am RETIRED/DEAD/COOKED"), not names.
  if (cleaned.length >= 4 && cleaned === cleaned.toUpperCase()) return undefined;
  if (authorNames.some(n => n.toLowerCase() === cleaned.toLowerCase())) return undefined;
  return cleaned;
}

/**
 * Returns the capitalized name a message self-names with when it doesn't match
 * any of the author's known names — a pasted/quoted-bio signal. undefined when
 * the message isn't a self-naming or names the author themselves.
 */
export function detectSelfNaming(content: string, authorNames: string[]): string | undefined {
  const m = content.match(selfNaming);
  return validLearnedName(m?.[1] ?? m?.[2], authorNames);
}

// Explicit naming requests — "call me Alby", "my name is X", "i go by X". The
// capitalized-name requirement does the filtering: "call me later" and "call me
// paranoid" don't produce a candidate. No /i flag — case is the signal.
const namingRequest = /(?:\b[cC]all me|\b[mM]y name is|\b[mM]y name'?s|\b[iI] go by|\b[yY]ou can call me|\brefer to me as|\bprefer to be called)\s+([A-Z][\w'.-]*)/;

/**
 * Returns the name the author explicitly asked to be called — a stronger signal
 * than detectSelfNaming (a request, not a maybe-quote). Same validation rules.
 */
export function detectNamingRequest(content: string, authorNames: string[]): string | undefined {
  return validLearnedName(content.match(namingRequest)?.[1], authorNames);
}

// Negation/correction cues on a bot-addressed message — cheap gate before the
// LLM contest check. Matches "I didn't mention", "you have me confused",
// "Correction: I did say…", etc.
const contestSignals = /\b(?:i (?:never|didn'?t|did not|do not) (?:say|said|mention|tell|write)|have me confused|you'?re (?:wrong|confused|making)|wrong person|that'?s not (?:true|me|right|what i)|never said|where did i say|you made (?:that|this|it) up|not true|correction:?|actually,? i did|i did say|i never said)\b/i;

/** Cheap gate: does this message look like the author contesting or correcting something? */
export function contestCue(content: string): boolean {
  return contestSignals.test(content);
}

// Corrections addressed at the bot's memory without an @-mention:
// "add that to the memory", "your memory doesn't go back that far", "what do you
// know about me". Tight enough that human-to-human chatter rarely fires it.
const botMemorySignals = /\b(?:add (?:that|this|it) to (?:the|your) memory|your (?:memory|memories|notes?) (?:doesn'?t|does not|do not|only|spans?|is)|what (?:do )?you (?:know|remember) about me|correct your (?:memory|notes?))\b/i;

/** Cheap gate: does this message address the bot's memory state without mentioning it? */
export function botMemoryCue(content: string): boolean {
  return botMemorySignals.test(content);
}

// Cheap gate for attaching local web tools (web_search / visit_url) to a reply
// call: a URL, a trailing question mark, or search-y vocabulary. Keeps tool
// definitions (and their prompt-token cost) off ordinary banter; the model
// self-gates actual tool use once they're attached.
const toolSignals = /https?:\/\/|\?\s*$|\b(?:google|search|look ?up|check (?:this|that|the|if)|latest|news|wiki(?:pedia)?|who won|what is|what'?s the|price of|release[ds]?|when (?:does|did|is|was)|how (?:much|many))\b/i;

/** Cheap gate: might this message need live web info or a fetched page? */
export function toolCues(content: string): boolean {
  return toolSignals.test(content);
}
