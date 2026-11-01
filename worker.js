const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const ALLOWED_HOSTS = new Set(["catcar.info", "www.catcar.info"]);
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function cleanSku(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: {
    ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=120"
  }});
}
function validateTargetUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Invalid target URL"); }
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS target URLs are allowed");
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error("Target host is not allowed");
  if (parsed.username || parsed.password || parsed.port) throw new Error("Credentials and custom ports are not allowed");
  return parsed.toString();
}
function decodeEntities(value) {
  return String(value || "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);|&#x([0-9a-f]+);/gi, (entity, decimal, hexadecimal) => {
      const codePoint = decimal ? Number(decimal) : parseInt(hexadecimal, 16);
      try {
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint) : entity;
      } catch {
        return entity;
      }
    });
}
function htmlText(value) {
  return decodeEntities(String(value || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}
function getAttribute(tag, name) {
  const source = String(tag || "");
  const attributes = source.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g);
  for (const item of attributes) {
    if (item[1].toLowerCase() === name.toLowerCase()) {
      return decodeEntities(item[2] ?? item[3] ?? item[4] ?? "");
    }
  }
  return "";
}
async function fetchHtml(initialUrl) {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(currentUrl, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8", "Accept": "text/html,application/xhtml+xml" }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location) throw new Error("CatCar returned a redirect without a location");
      if (redirects === 5) throw new Error("Too many redirects");
      currentUrl = validateTargetUrl(new URL(location, currentUrl).toString());
      continue;
    }
    if (!response.ok) {
      const diagnosticHeaders = {};
      for (const name of ["content-type", "server", "cf-ray", "via", "date", "location", "cf-cache-status", "x-cache", "x-powered-by"]) {
        const value = response.headers.get(name);
        if (value) diagnosticHeaders[name] = value.slice(0, 300);
      }
      let bodyExcerpt = "";
      try {
        bodyExcerpt = (await response.text()).replace(/\\s+/g, " ").trim().slice(0, 500);
      } catch (readError) {
        bodyExcerpt = "Could not read error response body: " + String(readError && readError.message || readError).slice(0, 200);
      }
      const error = new Error("CatCar returned HTTP " + response.status);
      error.upstreamStatus = response.status;
      error.upstreamHeaders = diagnosticHeaders;
      error.upstreamBodyExcerpt = bodyExcerpt;
      throw error;
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/html|text\/plain/i.test(contentType)) throw new Error("CatCar returned a non-HTML response");
    const html = await response.text();
    if (html.length > 5 * 1024 * 1024) throw new Error("CatCar response is too large");
    return html;
  }
  throw new Error("Too many redirects");
}
function absoluteCatCarLink(href, baseUrl) {
  try {
    const parsed = new URL(href, baseUrl);
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch { return ""; }
}
function extractNavigation(html, baseUrl, isHome) {
  const found = new Map();
  const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const anchorHtml = match[0];
    const openingTag = anchorHtml.match(/^<a\b[^>]*>/i)?.[0] || "";
    const href = getAttribute(openingTag, "href").trim();
    const rowStart = html.lastIndexOf("<tr", match.index);
    const previousRowEnd = html.lastIndexOf("</tr>", match.index);
    const rowEnd = html.indexOf("</tr>", match.index);
    const rowHtml = rowStart > previousRowEnd && rowEnd !== -1
      ? html.slice(rowStart, rowEnd + 5) : "";
    const cells = rowHtml.match(/<(?:th|td)\b[^>]*>[\s\S]*?<\/(?:th|td)>/gi) || [];
    const rowLabel = cells.map(htmlText).filter(Boolean).join(" · ");
    const imageTag = anchorHtml.match(/<img\b[^>]*>/i)?.[0] || "";
    const label = (rowLabel || htmlText(anchorHtml) || getAttribute(openingTag, "title") || getAttribute(imageTag, "alt")).replace(/\s+/g, " ").trim();
    const url = absoluteCatCarLink(href, baseUrl);
    if (!url || !label) continue;
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    const hasCatalogState = parsed.searchParams.has("l");
    const isBrandPath = /^\/[a-z0-9_-]+\/?$/i.test(parsed.pathname) && parsed.pathname !== "/";
    if (isHome) { if (!isBrandPath) continue; }
    else if (parsed.pathname === base.pathname && !hasCatalogState) continue;
    if (/^(русский|english|подключить каталоги|2026 catcar\.info)$/i.test(label) || url === baseUrl) continue;
    if (!found.has(url)) found.set(url, { label, url });
  }
  return Array.from(found.values());
}
function extractSchemeImage(html, baseUrl) {
  const tags = html.match(/<(?:a|img)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const isImage = /^<img\b/i.test(tag);
    const raw = isImage ? getAttribute(tag, "src") : getAttribute(tag, "href") || getAttribute(tag, "src");
    if (!raw) continue;
    try {
      const parsed = new URL(raw, baseUrl);
      if (/^https?:$/.test(parsed.protocol) && /\.(png|jpe?g|gif|webp)(?:$|[?#])/i.test(parsed.href) &&
        (parsed.hostname === "ci.catcar.info" || parsed.hostname.endsWith(".catcar.info"))) return parsed.toString();
    } catch {}
  }
  return "";
}
function extractParts(html) {
  const rowsHtml = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const rows = rowsHtml.map(rowHtml => {
    const cells = rowHtml.match(/<(?:th|td)\b[^>]*>[\s\S]*?<\/(?:th|td)>/gi) || [];
    return { text: htmlText(rowHtml), cells: cells.map(htmlText) };
  });
  const parts = [];
  const seen = new Set();
  const oemPattern = /\b(?:[A-Z0-9]{2,}-[A-Z0-9-]{2,}|[A-Z]{1,3}\d{4,}[A-Z0-9]*)\b/gi;
  rows.forEach((row, index) => {
    (row.text.match(oemPattern) || []).forEach(rawMatch => {
      const rawOem = rawMatch.trim();
      const cleanedOem = cleanSku(rawOem);
      if (!cleanedOem || seen.has(cleanedOem)) return;
      seen.add(cleanedOem);
      let pos = /^\d{1,4}$/.test(row.cells[0] || "") ? row.cells[0] : "";
      let name = row.cells[2] || "";
      if (!pos || !name) {
        for (let previous = index - 1; previous >= Math.max(0, index - 4); previous -= 1) {
          const candidate = rows[previous].cells;
          if (!pos && candidate.length >= 2 && /^\d{1,4}$/.test(candidate[0]) && candidate[1]) pos = candidate[0];
          if (!name && candidate.length >= 3 && candidate[2]) name = candidate[2];
          else if (!name && candidate.length >= 2 && candidate[1]) name = candidate[1];
          if (pos && name) break;
        }
      }
      if (!name && row.cells.length > 1) name = row.cells.filter(cell => cell !== rawOem).join(" ").trim();
      parts.push({ cleaned_oem: cleanedOem, raw_oem: rawOem, pos: pos || "—", name: (name || "Деталь").replace(/\s+/g, " ").trim() });
    });
  });
  return parts;
}
function parseCatalogPage(html, url, isHome) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return {
    success: true, page_url: url, title: htmlText(h1 ? h1[1] : titleTag ? titleTag[1] : ""),
    items: extractNavigation(html, url, isHome),
    scheme_image: isHome ? "" : extractSchemeImage(html, url),
    parts: isHome ? [] : extractParts(html)
  };
}
export default {
  async fetch(request) {
    const startedAt = Date.now();
    const requestUrl = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (method !== "GET") return jsonResponse(405, { success: false, error: "Method not allowed" });
    const params = requestUrl.searchParams;
    const action = params.get("action") || (params.has("url") ? "page" : "home");
    let targetUrl = "";
    let stage = "read_request";
    try {
      if (action === "home") {
        targetUrl = "https://www.catcar.info/";
        stage = "fetch_catcar_home";
        const html = await fetchHtml(targetUrl);
        stage = "parse_catcar_home";
        return jsonResponse(200, parseCatalogPage(html, targetUrl, true));
      }
      if (action === "page") {
        const rawUrl = params.get("url");
        if (!rawUrl) return jsonResponse(400, { success: false, error: "Missing url parameter" });
        stage = "validate_target_url";
        targetUrl = validateTargetUrl(rawUrl);
        stage = "fetch_catcar_page";
        const html = await fetchHtml(targetUrl);
        stage = "parse_catcar_page";
        return jsonResponse(200, parseCatalogPage(html, targetUrl, false));
      }
      return jsonResponse(400, { success: false, error: "Unknown action. Use action=home or action=page&url=..." });
    } catch (error) {
      const message = error && error.message ? error.message : "Unknown error";
      const validationError = ["Invalid target URL", "Only HTTPS target URLs are allowed", "Target host is not allowed", "Credentials and custom ports are not allowed"].includes(message);
      return jsonResponse(validationError ? 400 : 502, {
        success: false, error: validationError ? message : "CatCar request failed: " + message,
        diagnostic: {
          stage, action, target: targetUrl ? new URL(targetUrl).host : null,
          error_name: error && error.name ? String(error.name) : "Error",
          error_message: String(message).slice(0, 500),
          upstream_status: error && error.upstreamStatus ? error.upstreamStatus : null,
          upstream_headers: error && error.upstreamHeaders ? error.upstreamHeaders : null,
          upstream_body_excerpt: error && error.upstreamBodyExcerpt ? error.upstreamBodyExcerpt : null,
          elapsed_ms: Date.now() - startedAt
        }
      });
    }
  }
};