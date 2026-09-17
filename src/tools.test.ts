import assert from "node:assert/strict";
import test from "node:test";
import { executeTool, isSafeUrl, parseDdgLite, stripHtml } from "./tools.js";
import { toolCues } from "./perception.js";

// Pure tests — no network. webSearch/visitUrl correctness against live
// endpoints is exercised by the manual smoke script, not unit tests.

test("isSafeUrl blocks non-http schemes and private/local hosts", () => {
  assert.ok(!isSafeUrl("file:///etc/passwd"));
  assert.ok(!isSafeUrl("javascript:alert(1)"));
  assert.ok(!isSafeUrl("not a url"));
  assert.ok(!isSafeUrl("http://localhost:8080/admin"));
  assert.ok(!isSafeUrl("http://foo.local/x"));
  assert.ok(!isSafeUrl("http://router.internal"));
  assert.ok(!isSafeUrl("http://127.0.0.1"));
  assert.ok(!isSafeUrl("http://10.0.0.5"));
  assert.ok(!isSafeUrl("http://192.168.1.1"));
  assert.ok(!isSafeUrl("http://169.254.169.254/latest/meta-data")); // cloud metadata
  assert.ok(!isSafeUrl("http://172.16.0.1"));
  assert.ok(!isSafeUrl("http://[::1]:8080"));
  assert.ok(!isSafeUrl("http://[fe80::1]"));
  assert.ok(isSafeUrl("https://example.com/page?q=1"));
  assert.ok(isSafeUrl("https://en.wikipedia.org/wiki/Main_Page"));
  assert.ok(isSafeUrl("http://8.8.8.8/dns-query")); // public IP literal is allowed
});

test("stripHtml removes scripts/styles/tags and decodes entities", () => {
  const html = `<p>Hello <b>world</b> &amp; friends</p><script>var x=1;</script><style>.a{}</style><p>Second&nbsp;para &#8212; done</p>`;
  const out = stripHtml(html);
  assert.ok(out.includes("Hello world & friends"));
  assert.ok(out.includes("Second para"));
  assert.ok(!out.includes("var x"));
  assert.ok(!out.includes("<b>"));
  assert.ok(!out.includes(".a{}"));
});

test("parseDdgLite extracts results and decodes uddg redirect URLs", () => {
  const html = `
    <table>
      <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc" class='result-link'>Example Page Title</a></td></tr>
      <tr><td class='result-snippet'>A snippet <b>about</b> the thing.</td></tr>
      <tr><td class='result-url'>example.com/page</td></tr>
      <tr><td><a rel="nofollow" href="https://direct.example.org/" class='result-link'>Direct Link</a></td></tr>
      <tr><td class='result-snippet'>Second snippet here.</td></tr>
    </table>`;
  const results = parseDdgLite(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Example Page Title");
  assert.equal(results[0].url, "https://example.com/page"); // uddg-decoded
  assert.equal(results[0].snippet, "A snippet about the thing.");
  assert.equal(results[1].url, "https://direct.example.org/");
  assert.equal(results[1].snippet, "Second snippet here.");
});

test("executeTool returns error strings for bad input, never throws", async () => {
  assert.match(await executeTool("nope", "{}"), /unknown tool/);
  assert.match(await executeTool("web_search", "{bad json"), /error:/);
  assert.match(await executeTool("web_search", "{}"), /missing query/);
  assert.match(await executeTool("visit_url", "{\"url\":\"\"}"), /missing url/);
  // SSRF guard fires before any network access
  assert.match(await executeTool("visit_url", "{\"url\":\"http://192.168.1.1/\"}"), /not allowed/);
  assert.match(await executeTool("visit_url", "{\"url\":\"file:///etc/passwd\"}"), /not allowed/);
});

test("toolCues gates tool attachment to plausible needs", () => {
  assert.ok(toolCues("check out https://example.com"));
  assert.ok(toolCues("what is the latest python version?"));
  assert.ok(toolCues("google it for me"));
  assert.ok(toolCues("who won the debate"));
  assert.ok(!toolCues("lol nice one"));
  assert.ok(!toolCues("im going to bed gn"));
});
