import { lookup } from "node:dns/promises";
import { executeLookupTool, LOOKUP_TOOL_NAMES, type ToolCtx } from "./lookup-tools.js";

// Local tool implementations for gpt-oss-120b tool calling — free alternatives to
// Groq Compound's billed built-ins. web_search scrapes DuckDuckGo's lite endpoint
// (no API key); visit_url fetches a page and strips it to text. Both are guarded:
// SSRF blocklist on visit_url, and every failure returns an error string as the
// tool result rather than throwing — the model should always get *something* back.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAGE_CHARS = 3_000;
const MAX_SEARCH_RESULTS = 5;

// ── URL safety ────────────────────────────────────────────────────────────────

// Assumption: this blocklist checks the hostname as parsed by Node's URL class and
// resolved via node:dns — it does NOT decode decimal/octal/hex IP-literal forms
// (e.g. http://2130706433/ == 127.0.0.1, or http://0x7f.0.0.1/). curl and some
// browsers normalize these before connecting; Node's fetch/URL do not, so today
// they fail DNS resolution rather than reaching a private address. If the fetch
// implementation or runtime ever changes that behavior, this check needs to
// explicitly decode and normalize those forms before testing them.

const blockedSuffixes = ["localhost", ".local", ".internal", ".lan", ".home", ".corp", ".test", ".invalid"];

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true; // malformed IP literal — not a host
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)   // CGNAT
    || (a === 169 && b === 254)             // link-local / cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;                            // multicast/reserved
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  return h === "::1" || h === "::"
    || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")
    || h.startsWith("ff") || h.startsWith("::ffff:");
}

export function isPrivateAddress(host: string): boolean {
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

/** Cheap synchronous check: scheme, hostname blocklist, IP-literal ranges. */
export function isSafeUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!host || blockedSuffixes.some(s => host === s || host.endsWith(s))) return false;
  if (isPrivateAddress(host)) return false;
  return true;
}

/** DNS check: block hosts that resolve to private addresses (rebinding defence). */
async function resolvesToPrivateAddress(host: string): Promise<boolean> {
  if (isPrivateAddress(host)) return true; // literal already handled, belt-and-braces
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some(a => isPrivateAddress(a.address));
  } catch {
    return true; // can't resolve → treat as unsafe
  }
}

// ── HTML → text ───────────────────────────────────────────────────────────────

const entities: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#39;|&#(\d+);/g, (m, dec) => dec ? String.fromCharCode(Number(dec)) : entities[m] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// ── web_search ────────────────────────────────────────────────────────────────

/** Parse DuckDuckGo lite result HTML into {title, url, snippet} rows. */
export function parseDdgLite(html: string): Array<{ title: string; url: string; snippet: string }> {
  const links: Array<{ title: string; url: string }> = [];
  for (const m of html.matchAll(/<a\b[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[0].match(/href=['"]([^'"]+)['"]/i)?.[1] ?? "";
    // DDG wraps results in a redirect: //duckduckgo.com/l/?uddg=<encoded target>
    const uddg = href.match(/[?&]uddg=([^&]+)/)?.[1];
    const url = uddg ? decodeURIComponent(uddg) : href;
    if (!url || links.some(l => l.url === url)) continue;
    links.push({ title: stripHtml(m[1]), url });
    if (links.length >= MAX_SEARCH_RESULTS) break;
  }
  const snippets = [...html.matchAll(/<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)]
    .map(m => stripHtml(m[1]));
  return links.map((l, i) => ({ ...l, snippet: snippets[i] ?? "" }));
}

async function instantAnswer(query: string): Promise<string> {
  const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
    headers: { "user-agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return "";
  const data = await res.json() as { AbstractText?: string; AbstractURL?: string; Answer?: string };
  const text = data.AbstractText || data.Answer || "";
  return text ? `${text}${data.AbstractURL ? `\nSource: ${data.AbstractURL}` : ""}` : "";
}

export async function webSearch(query: string): Promise<string> {
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const results = parseDdgLite(await res.text());
      if (results.length) {
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
      }
    }
    // Fallback: instant answers API (good for definitions, entities)
    const answer = await instantAnswer(query);
    return answer || "no results found";
  } catch (err) {
    return `search failed: ${(err as Error).message.slice(0, 120)}`;
  }
}

// ── visit_url ─────────────────────────────────────────────────────────────────

export async function visitUrl(rawUrl: string): Promise<string> {
  try {
    let url = rawUrl;
    // Follow redirects manually (max 3 hops) so every hop is re-validated.
    for (let hop = 0; hop <= 3; hop++) {
      if (!isSafeUrl(url)) return "error: url not allowed";
      const host = new URL(url).hostname;
      if (await resolvesToPrivateAddress(host)) return "error: url resolves to a private address";
      const res = await fetch(url, {
        headers: { "user-agent": UA }, redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) return `error: redirect with no location (HTTP ${res.status})`;
        url = new URL(next, url).toString();
        continue;
      }
      if (!res.ok) return `error: HTTP ${res.status}`;
      const type = res.headers.get("content-type") ?? "";
      if (type && !/text\/|application\/(json|ld\+json)/.test(type)) return `error: unsupported content type ${type.split(";")[0]}`;
      const size = Number(res.headers.get("content-length") ?? 0);
      if (size > 1_000_000) return "error: page too large";
      const body = type.includes("text/html") ? stripHtml(await res.text()) : (await res.text()).slice(0, 1_000_000);
      return body.slice(0, MAX_PAGE_CHARS) || "error: empty page";
    }
    return "error: too many redirects";
  } catch (err) {
    return `error: ${(err as Error).message.slice(0, 120)}`;
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export const replyToolDefs = [
  { type: "function", function: {
    name: "web_search",
    description: "Search the web for current information. Returns a short list of result titles, URLs, and snippets.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "the search query" },
    }, required: ["query"], additionalProperties: false },
  } },
  { type: "function", function: {
    name: "visit_url",
    description: "Fetch a web page by URL and return its text content (truncated).",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "the http(s) URL to fetch" },
    }, required: ["url"], additionalProperties: false },
  } },
  { type: "function", function: {
    name: "lookup_person",
    description: "Look up a server member's profile and attributes by name.",
    parameters: { type: "object", properties: {
      name: { type: "string", description: "the member's name as written in chat" },
    }, required: ["name"], additionalProperties: false },
  } },
  { type: "function", function: {
    name: "lookup_relationship",
    description: "Look up the recorded dynamic between two members: asserted relationships, recent observations, shared events.",
    parameters: { type: "object", properties: {
      person_a: { type: "string", description: "one member's name" },
      person_b: { type: "string", description: "the other member's name" },
    }, required: ["person_a", "person_b"], additionalProperties: false },
  } },
  { type: "function", function: {
    name: "search_memories",
    description: "Search remembered facts. Optionally scope to one member by name.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "text to search memory contents for" },
      subject: { type: "string", description: "optional member name to scope the search to" },
    }, required: ["query"], additionalProperties: false },
  } },
  { type: "function", function: {
    name: "lookup_event",
    description: "Look up a recorded server event by title.",
    parameters: { type: "object", properties: {
      title: { type: "string", description: "words from the event title" },
    }, required: ["title"], additionalProperties: false },
  } },
] as const;

/** Execute one model-requested tool call. Always resolves to a string — errors become tool output. */
export async function executeTool(name: string, argsJson: string, ctx?: ToolCtx): Promise<string> {
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    if (name === "web_search") {
      if (typeof args.query !== "string" || !args.query.trim()) return "error: missing query";
      return await webSearch(args.query.trim());
    }
    if (name === "visit_url") {
      if (typeof args.url !== "string" || !args.url.trim()) return "error: missing url";
      return await visitUrl(args.url.trim());
    }
    if (LOOKUP_TOOL_NAMES.has(name)) {
      if (!ctx) return "error: lookup tools unavailable";
      return await executeLookupTool(name, args, ctx);
    }
    return `error: unknown tool ${name}`;
  } catch (err) {
    return `error: ${(err as Error).message.slice(0, 120)}`;
  }
}
