import { lookup as dnsLookupCb } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
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
    || h.startsWith("::")                    // ::/16: v4-mapped ::ffff:, v4-compat ::/96 — nothing public lives here
    || /^fe[89ab]/.test(h)                   // fe80::/10 link-local
    || h.startsWith("fc") || h.startsWith("fd") // ULA
    || h.startsWith("ff")                    // multicast
    || h.startsWith("64:ff9b:")              // NAT64 — embeds an IPv4
    || h.startsWith("2002:")                 // 6to4 — embeds an IPv4
    || h.startsWith("2001:0:") || h.startsWith("2001:0000:"); // Teredo — embeds an IPv4
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

/** DNS check: block hosts that resolve to private addresses (rebinding defence).
 * Exported for setup-time validation — the authoritative gate is safeLookup at
 * connect time; this catches bad hostnames early, at input time. */
export async function resolvesToPrivateAddress(host: string): Promise<boolean> {
  if (isPrivateAddress(host)) return true; // literal already handled, belt-and-braces
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some(a => isPrivateAddress(a.address));
  } catch {
    return true; // can't resolve → treat as unsafe
  }
}

// ── Connect-time-validated HTTP ───────────────────────────────────────────────
// A check-then-fetch pair resolves DNS twice — attacker-controlled DNS can
// answer public for the check and private for the connect (rebinding/TOCTOU).
// safeLookup runs INSIDE the socket connect path, so the same answer that is
// validated is the one connected to — the TOCTOU window closes entirely.

export const safeLookup: LookupFunction = ((hostname: string, options: { all?: boolean } & Record<string, unknown>, callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void) => {
  dnsLookupCb(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs?.length || addrs.some(a => isPrivateAddress(a.address))) {
      return callback(new Error(`blocked: ${hostname} resolves to a private address`));
    }
    if (options?.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}) as LookupFunction;

/** Byte-capped read of a fetch() Response body — counts bytes as they stream
 * so a lying/absent Content-Length can't exhaust memory. */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`body over ${maxBytes} bytes`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error(`body over ${maxBytes} bytes`); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export type SafeResponse = {
  status: number;
  headers: IncomingMessage["headers"];
  /** Read the body with a hard byte cap — destroys the socket the moment the
   * cap is exceeded, so a lying/absent Content-Length can't exhaust memory. */
  readBody: (maxBytes: number) => Promise<Buffer>;
};

/** http/https GET with connect-time DNS validation. Only http(s) URLs are
 * accepted; the caller still runs isSafeUrl for hostname/scheme policy. */
export async function safeRequest(rawUrl: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<SafeResponse> {
  const url = new URL(rawUrl);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: { "user-agent": UA },
      lookup: safeLookup,
      timeout: timeoutMs,
    }, (res) => resolve({
      status: res.statusCode ?? 0,
      headers: res.headers,
      readBody: (maxBytes) => new Promise<Buffer>((res2, rej2) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) { res.destroy(); rej2(new Error(`body over ${maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        res.on("end", () => res2(Buffer.concat(chunks)));
        res.on("error", rej2);
      }),
    }));
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** SSRF-guarded GET for binary/image bodies — safeRequest plus a manual
 * redirect loop so every hop is re-validated (isSafeUrl policy at input,
 * safeLookup at connect). Mirrors visit_url's discipline; returns the body
 * and resolved MIME. Throws on failure — callers decide fault tolerance. */
export async function fetchImageBytes(rawUrl: string, maxBytes: number): Promise<{ buf: Buffer; mime: string }> {
  let url = rawUrl;
  for (let hop = 0; hop <= 3; hop++) {
    if (!isSafeUrl(url)) throw new Error("image url not allowed");
    const res = await safeRequest(url, 10_000);
    if (res.status >= 300 && res.status < 400) {
      const next = headerValue(res.headers["location"]);
      if (!next) throw new Error(`image redirect with no location (HTTP ${res.status})`);
      url = new URL(next, url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`image fetch failed: ${res.status}`);
    const declared = Number(headerValue(res.headers["content-length"]) ?? 0);
    if (declared > maxBytes) throw new Error(`image over byte cap: ${declared}`);
    const mime = (headerValue(res.headers["content-type"]) ?? "").split(";")[0].trim() || "image/png";
    return { buf: await res.readBody(maxBytes), mime };
  }
  throw new Error("image fetch: too many redirects");
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
      // Fast-path DNS check first; safeRequest's lookup re-validates at connect
      // time, which is the authoritative gate against rebinding.
      if (await resolvesToPrivateAddress(host)) return "error: url resolves to a private address";
      const res = await safeRequest(url);
      if (res.status >= 300 && res.status < 400) {
        const next = headerValue(res.headers["location"]);
        if (!next) return `error: redirect with no location (HTTP ${res.status})`;
        url = new URL(next, url).toString();
        continue;
      }
      if (res.status < 200 || res.status >= 300) return `error: HTTP ${res.status}`;
      const type = headerValue(res.headers["content-type"]) ?? "";
      if (type && !/text\/|application\/(json|ld\+json)/.test(type)) return `error: unsupported content type ${type.split(";")[0]}`;
      const size = Number(headerValue(res.headers["content-length"]) ?? 0);
      if (size > 1_000_000) return "error: page too large";
      const raw = (await res.readBody(1_000_000)).toString("utf8");
      const body = type.includes("text/html") ? stripHtml(raw) : raw;
      return body.slice(0, MAX_PAGE_CHARS) || "error: empty page";
    }
    return "error: too many redirects";
  } catch (err) {
    return `error: ${(err as Error).message.slice(0, 120)}`;
  }
}

export function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
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
