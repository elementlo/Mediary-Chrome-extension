import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRule,
  normalizeRules,
  rulesForPage,
  candidateAllowed,
  matchPageRule
} from "../extension/site-rules.js";

const demoRule = {
  hostname: "site.test",
  urlFilter: "^https://site\\.test/api/",
  pagePath: "^/v/([^/]+)/?$",
  entryPath: "/api/hls/$1",
  kind: "wrapped-hls"
};

test("normalizeRule fills defaults, trims values and drops empty optionals", () => {
  const rule = normalizeRule({ hostname: " Site.Test " });
  assert.equal(rule.hostname, "site.test");
  assert.equal(rule.kind, "wrapped-hls");
  assert.equal(rule.urlFilter, undefined);
  assert.equal(rule.pagePath, undefined);
  assert.equal(rule.entryPath, undefined);
  // No descriptive fields leak into the normalized rule.
  assert.deepEqual(Object.keys(rule).sort(), ["hostname", "kind"]);
});

test("normalizeRule rejects malformed rules", () => {
  assert.throws(() => normalizeRule(null), /对象/);
  assert.throws(() => normalizeRule({ hostname: "" }), /hostname/);
  assert.throws(() => normalizeRule({ hostname: "a.test", urlFilter: "(" }), /正则/);
  assert.throws(() => normalizeRule({ hostname: "a.test", pagePath: "(" }), /正则/);
  assert.throws(
    () => normalizeRule({ hostname: "a.test", entryPath: "/x/$1" }),
    /pagePath/
  );
  assert.throws(
    () => normalizeRule({ hostname: "a.test", pagePath: "^/v$", entryPath: "/x/$1" }),
    /分组/
  );
  assert.throws(
    () => normalizeRule({ hostname: "a.test", kind: "mp4" }),
    /kind/
  );
});

test("normalizeRules drops exact duplicates and rejects non-arrays", () => {
  assert.equal(normalizeRules([demoRule, { ...demoRule }]).length, 1);
  assert.throws(() => normalizeRules("nope"), /数组/);
});

test("rulesForPage selects rules by exact hostname", () => {
  assert.equal(rulesForPage("https://site.test/v/abc", [demoRule]).length, 1);
  assert.equal(rulesForPage("https://other.test/v/abc", [demoRule]).length, 0);
  assert.equal(rulesForPage("not-a-url", [demoRule]).length, 0);
  assert.equal(rulesForPage("", [demoRule]).length, 0);
  assert.equal(rulesForPage("https://site.test/v/abc", []).length, 0);
});

test("candidateAllowed passes everything when no rule matches the page", () => {
  assert.equal(candidateAllowed("https://any.test/whatever.png", []), true);
  assert.equal(candidateAllowed("https://any.test/x", null), true);
});

test("candidateAllowed filters by urlFilter when rules exist", () => {
  const rules = [demoRule];
  assert.equal(candidateAllowed("https://site.test/api/hls/abc", rules), true);
  assert.equal(candidateAllowed("https://site.test/logo.png", rules), false);
  // A host rule without urlFilter keeps every candidate on that host.
  const loose = [{ ...demoRule, urlFilter: undefined }];
  assert.equal(candidateAllowed("https://site.test/anything", loose), true);
});

test("candidateAllowed keeps nothing when a stored filter no longer compiles", () => {
  const broken = [{ ...demoRule, urlFilter: "(" }];
  assert.equal(candidateAllowed("https://site.test/api/hls/abc", broken), false);
});

test("matchPageRule builds the entry from capture groups", () => {
  const candidate = matchPageRule("https://site.test/v/abc123", [demoRule]);
  assert.equal(candidate.url, "https://site.test/api/hls/abc123");
  assert.equal(candidate.kind, "wrapped-hls");
  assert.equal(candidate.pageUrl, "https://site.test/v/abc123");
});

test("matchPageRule returns null without pagePath/entryPath or a match", () => {
  const filterOnly = normalizeRule({ hostname: "site.test", urlFilter: "^https://site\\.test/api/" });
  assert.equal(matchPageRule("https://site.test/v/abc", [filterOnly]), null);
  assert.equal(matchPageRule("https://other.test/v/abc", [demoRule]), null);
  assert.equal(matchPageRule("https://site.test/watch/abc", [demoRule]), null);
  assert.equal(matchPageRule("not-a-url", [demoRule]), null);
  assert.equal(matchPageRule("https://site.test/v/abc", []), null);
});

test("matchPageRule supports multiple groups and plain hls kind", () => {
  const rule = normalizeRule({
    hostname: "multi.test",
    pagePath: "^/show/([^/]+)/ep/([^/]+)$",
    entryPath: "/stream/$1/$2.m3u8",
    kind: "hls"
  });
  const candidate = matchPageRule("https://multi.test/show/foo/ep/3", [rule]);
  assert.equal(candidate.url, "https://multi.test/stream/foo/3.m3u8");
  assert.equal(candidate.kind, "hls");
});

test("first matching rule with an entry template wins", () => {
  const second = { ...demoRule, entryPath: "/other/$1" };
  const candidate = matchPageRule("https://site.test/v/abc", [demoRule, second]);
  assert.equal(candidate.url, "https://site.test/api/hls/abc");
});
