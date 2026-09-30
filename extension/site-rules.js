// Optional, user-supplied rules (JSON import only; no built-in data, no form
// UI).
//
// Detection itself is fully generic: HLS by extension/MIME/query params,
// direct video by extension/MIME, and wrapped HLS by probing any request
// that redirects to a `.png` (verified later by unwrapping its `roUd`
// chunk). Rules are an *extra filter* layered on top:
//
// - When the current page's hostname matches one or more rules, only
//   candidates passing those rules are kept.
// - When no rule matches the page, generic detection passes everything.
//
// A rule can also reconstruct an entry URL for pages whose stream request
// cannot be observed at all (client-side constructed), via pagePath +
// entryPath.
//
// Rule shape (all RegExp fields are sources, not literals):
// {
//   hostname:  string   exact page hostname the rule applies to
//   urlFilter: string?  a captured candidate is kept only if its URL matches
//   pagePath:  string?  matched against the page pathname
//   entryPath: string?  entry pathname template ($1..$n = pagePath groups);
//                       fallback candidate when nothing was captured
//   kind:      "wrapped-hls" | "hls"   fallback kind (default "wrapped-hls")
// }

const VALID_KINDS = new Set(["wrapped-hls", "hls"]);

export const RULES_STORAGE_KEY = "rules";

function compile(source, field) {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(`${field} 不是合法正则: ${error.message}`);
  }
}

/// Validates one rule object. Returns a normalized copy, or throws with a
/// human-readable reason.
export function normalizeRule(input) {
  if (!input || typeof input !== "object") throw new Error("规则必须是对象");
  const str = (value, field) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field} 必须是非空字符串`);
    }
    return value.trim();
  };
  const optionalStr = (value, field) => {
    if (value == null) return null;
    return str(value, field);
  };

  const hostname = str(input.hostname, "hostname").toLowerCase();
  const urlFilter = optionalStr(input.urlFilter, "urlFilter");
  if (urlFilter) compile(urlFilter, "urlFilter");

  const pagePath = optionalStr(input.pagePath, "pagePath");
  const entryPath = optionalStr(input.entryPath, "entryPath");
  if (entryPath && !pagePath) throw new Error("entryPath 需要同时提供 pagePath");
  if (pagePath) {
    const groups = (pagePath.match(/\(/g) || []).length;
    compile(pagePath, "pagePath");
    if (entryPath) {
      for (const placeholder of entryPath.matchAll(/\$(\d+)/g)) {
        const index = Number(placeholder[1]);
        if (index < 1 || index > groups) {
          throw new Error(`entryPath 引用了不存在的分组 $${index}`);
        }
      }
    }
  }

  const kind = input.kind == null ? "wrapped-hls" : str(input.kind, "kind");
  if (!VALID_KINDS.has(kind)) throw new Error(`kind 无效: ${kind}`);

  return {
    hostname,
    ...(urlFilter ? { urlFilter } : {}),
    ...(pagePath ? { pagePath } : {}),
    ...(entryPath ? { entryPath } : {}),
    kind
  };
}

/// Stable identity for dedup, derived from the meaningful fields.
function ruleKey(rule) {
  return [rule.hostname, rule.urlFilter || "", rule.pagePath || "",
    rule.entryPath || "", rule.kind].join("|");
}

/// Validates a whole rule list, dropping exact duplicates. Throws on the
/// first invalid rule.
export function normalizeRules(input) {
  if (!Array.isArray(input)) throw new Error("规则必须是数组");
  const seen = new Set();
  const rules = [];
  for (const item of input) {
    const rule = normalizeRule(item);
    const id = ruleKey(rule);
    if (seen.has(id)) continue;
    seen.add(id);
    rules.push(rule);
  }
  return rules;
}

/// Rules that apply to [pageUrl]'s hostname. Empty when no rule matches —
/// callers then fall back to unfiltered generic detection.
export function rulesForPage(pageUrl, rules) {
  if (!Array.isArray(rules) || !rules.length || !pageUrl) return [];
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  return rules.filter(rule => rule.hostname === page.hostname.toLowerCase());
}

/// Keeps a captured candidate only if it passes [pageRules]. With no rules
/// for the page, every candidate passes (generic detection).
export function candidateAllowed(candidateUrl, pageRules) {
  if (!Array.isArray(pageRules) || !pageRules.length) return true;
  const url = String(candidateUrl);
  return pageRules.some(rule => {
    if (!rule.urlFilter) return true; // A host rule without a filter keeps all.
    try {
      return new RegExp(rule.urlFilter).test(url);
    } catch {
      return false; // A stored rule that no longer compiles keeps nothing.
    }
  });
}

/// Builds a stream-entry candidate from [pageUrl] using the first matching
/// rule that defines pagePath + entryPath, or returns null.
export function matchPageRule(pageUrl, rules) {
  const pageRules = rulesForPage(pageUrl, rules);
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }

  for (const rule of pageRules) {
    if (!rule.pagePath || !rule.entryPath) continue;
    const match = page.pathname.match(new RegExp(rule.pagePath));
    if (!match) continue;
    const entryPath = rule.entryPath.replace(/\$(\d+)/g, (_, index) => {
      const value = match[Number(index)];
      return value == null ? "" : value;
    });
    return {
      url: `${page.origin}${entryPath}`,
      kind: rule.kind || "wrapped-hls",
      pageUrl: page.href,
      seenAt: Date.now()
    };
  }
  return null;
}
