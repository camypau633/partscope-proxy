const axios = require('axios');
const cheerio = require('cheerio');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function cleanSku(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=120'
    },
    body: JSON.stringify(payload)
  };
}

function validateTargetUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid target URL');
  }

  const allowedHosts = new Set(['catcar.info', 'www.catcar.info']);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS target URLs are allowed');
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) throw new Error('Target host is not allowed');
  if (parsed.username || parsed.password || parsed.port) {
    throw new Error('Credentials and custom ports are not allowed');
  }
  return parsed.toString();
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 12000,
    maxRedirects: 5,
    beforeRedirect: (options) => {
      const protocol = String(options.protocol || '');
      const hostname = String(options.hostname || options.host || '').toLowerCase();
      const port = String(options.port || '');
      if (protocol !== 'https:' || !['catcar.info', 'www.catcar.info'].includes(hostname) || (port && port !== '443')) {
        throw new Error('CatCar redirected to a non-allowed address');
      }
    },
    maxContentLength: 5 * 1024 * 1024,
    maxBodyLength: 5 * 1024 * 1024,
    responseType: 'text',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
    }
  });
  return response.data;
}

function absoluteCatCarLink(href, baseUrl) {
  try {
    const parsed = new URL(href, baseUrl);
    if (parsed.protocol !== 'https:') return '';
    if (!['catcar.info', 'www.catcar.info'].includes(parsed.hostname.toLowerCase())) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractNavigation($, baseUrl, isHome) {
  const found = new Map();

  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const href = String(anchor.attr('href') || '').trim();
    const rowLabel = anchor.closest('tr').find('th,td').map((__, cell) =>
      $(cell).text().replace(/\s+/g, ' ').trim()
    ).get().filter(Boolean).join(' · ');
    const label = (rowLabel || anchor.text().trim() || anchor.attr('title') || anchor.find('img').attr('alt') || '')
      .replace(/\s+/g, ' ')
      .trim();
    const url = absoluteCatCarLink(href, baseUrl);
    if (!url || !label) return;

    const parsed = new URL(url);
    const base = new URL(baseUrl);
    const hasCatalogState = parsed.searchParams.has('l');
    const isBrandPath = /^\/[a-z0-9_-]+\/?$/i.test(parsed.pathname) && parsed.pathname !== '/';

    if (isHome) {
      if (!isBrandPath) return;
    } else if (parsed.pathname === base.pathname && !hasCatalogState) {
      return;
    }

    if (/^(русский|english|подключить каталоги|2026 catcar\.info)$/i.test(label)) return;
    if (url === baseUrl) return;
    if (!found.has(url)) found.set(url, { label, url });
  });

  return Array.from(found.values());
}

function extractSchemeImage($, baseUrl) {
  let image = '';
  $('a[href], img[src]').each((_, element) => {
    if (image) return;
    const node = $(element);
    const raw = node.is('img') ? node.attr('src') : node.attr('href');
    if (!raw) return;
    try {
      const parsed = new URL(raw, baseUrl);
      if (!/^https?:$/.test(parsed.protocol)) return;
      if (/\.(png|jpe?g|gif|webp)(?:$|[?#])/i.test(parsed.href) &&
          (parsed.hostname === 'ci.catcar.info' || parsed.hostname.endsWith('.catcar.info'))) {
        image = parsed.toString();
      }
    } catch {
      // Ignore malformed image URLs.
    }
  });
  return image;
}

function extractParts($) {
  const rows = [];
  $('tr').each((_, element) => {
    const cells = $(element).find('th,td').map((__, cell) =>
      $(cell).text().replace(/\s+/g, ' ').trim()
    ).get();
    rows.push({ text: $(element).text().replace(/\s+/g, ' ').trim(), cells });
  });

  const parts = [];
  const seen = new Set();
  const oemPattern = /\b(?:[A-Z0-9]{2,}-[A-Z0-9-]{2,}|[A-Z]{1,3}\d{4,}[A-Z0-9]*)\b/gi;

  rows.forEach((row, index) => {
    const matches = row.text.match(oemPattern) || [];
    matches.forEach((rawMatch) => {
      const rawOem = rawMatch.trim();
      const cleanedOem = cleanSku(rawOem);
      if (!cleanedOem || seen.has(cleanedOem)) return;
      seen.add(cleanedOem);

      // CatCar's parts table places position, OEM and description in the same row.
      // Keep a fallback for layouts where these values are split across nearby rows.
      let pos = /^\d{1,4}$/.test(row.cells[0] || '') ? row.cells[0] : '';
      let name = row.cells[2] || '';

      if (!pos || !name) {
        for (let previous = index - 1; previous >= Math.max(0, index - 4); previous -= 1) {
          const candidate = rows[previous].cells;
          if (!pos && candidate.length >= 2 && /^\d{1,4}$/.test(candidate[0]) && candidate[1]) {
            pos = candidate[0];
          }
          if (!name && candidate.length >= 3 && candidate[2]) {
            name = candidate[2];
          } else if (!name && candidate.length >= 2 && candidate[1]) {
            name = candidate[1];
          }
          if (pos && name) break;
        }
      }

      if (!name && row.cells.length > 1) {
        name = row.cells.slice(1).filter((cell) => cell !== rawOem).join(' ').trim();
      }

      parts.push({
        cleaned_oem: cleanedOem,
        raw_oem: rawOem,
        pos: pos || '—',
        name: (name || 'Деталь').replace(/\s+/g, ' ').trim()
      });
    });
  });

  return parts;
}

function parseCatalogPage(html, url, isHome) {
  const $ = cheerio.load(html);
  const title = ($('h1').first().text() || $('title').first().text() || '')
    .replace(/\s+/g, ' ')
    .trim();

  const items = extractNavigation($, url, isHome);
  const schemeImage = isHome ? '' : extractSchemeImage($, url);
  const parts = isHome ? [] : extractParts($);

  return {
    success: true,
    page_url: url,
    title,
    items,
    scheme_image: schemeImage,
    parts
  };
}

exports.handler = async function (event) {
  const startedAt = Date.now();
  let stage = 'read_request';
  let action = 'unknown';
  let targetUrl = '';
  const method = event.httpMethod || event.httpMethodName || 'GET';

  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (method !== 'GET') {
    return jsonResponse(405, { success: false, error: 'Method not allowed' });
  }

  const params = event.queryStringParameters || {};
  action = params.action || (params.url ? 'page' : 'home');

  try {
    if (action === 'home') {
      targetUrl = 'https://www.catcar.info/';
      stage = 'fetch_catcar_home';
      const html = await fetchHtml(targetUrl);
      stage = 'parse_catcar_home';
      return jsonResponse(200, parseCatalogPage(html, targetUrl, true));
    }

    if (action === 'page') {
      if (!params.url) {
        return jsonResponse(400, { success: false, error: 'Missing url parameter' });
      }
      stage = 'validate_target_url';
      targetUrl = validateTargetUrl(params.url);
      stage = 'fetch_catcar_page';
      const html = await fetchHtml(targetUrl);
      stage = 'parse_catcar_page';
      return jsonResponse(200, parseCatalogPage(html, targetUrl, false));
    }

    return jsonResponse(400, {
      success: false,
      error: 'Unknown action. Use action=home or action=page&url=...'
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Unknown error';
    const validationError = [
      'Invalid target URL',
      'Only HTTPS target URLs are allowed',
      'Target host is not allowed',
      'Credentials and custom ports are not allowed'
    ].includes(message);
    const upstream = error && error.response ? error.response : null;
    const diagnostic = {
      stage,
      action,
      target: targetUrl ? new URL(targetUrl).host : null,
      error_name: error && error.name ? String(error.name) : 'Error',
      error_code: error && error.code ? String(error.code) : null,
      error_message: String(message).slice(0, 500),
      upstream_status: upstream && upstream.status ? upstream.status : null,
      upstream_status_text: upstream && upstream.statusText ? String(upstream.statusText).slice(0, 200) : null,
      redirect_location: upstream && upstream.headers && upstream.headers.location
        ? String(upstream.headers.location).slice(0, 500)
        : null,
      elapsed_ms: Date.now() - startedAt
    };

    return jsonResponse(validationError ? 400 : 502, {
      success: false,
      error: validationError ? message : 'CatCar request failed: ' + message,
      diagnostic
    });
  }
};
