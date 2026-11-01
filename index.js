const axios = require('axios');
const cheerio = require('cheerio');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function cleanSku(sku) {
    if (!sku) return "";
    return sku.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function jsonResponse(statusCode, payload) {
    return {
        statusCode,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8'
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

    // This endpoint is intentionally restricted to catcar.info.
    // Accepting arbitrary URLs would create an SSRF-capable open proxy.
    const allowedHosts = new Set(['catcar.info', 'www.catcar.info']);

    if (parsed.protocol !== 'https:') {
        throw new Error('Only HTTPS target URLs are allowed');
    }

    if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
        throw new Error('Target host is not allowed');
    }

    if (parsed.username || parsed.password || parsed.port) {
        throw new Error('Credentials and custom ports are not allowed');
    }

    return parsed.toString();
}

exports.handler = async function (event, context) {
    const method = event.httpMethod || event.httpMethodName || 'GET';

    // Handle CORS preflight OPTIONS requests from the browser.
    if (method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: ''
        };
    }

    if (method !== 'GET') {
        return jsonResponse(405, {
            success: false,
            error: 'Method not allowed'
        });
    }

    const targetUrl = event.queryStringParameters &&
        event.queryStringParameters.url;

    if (!targetUrl) {
        return jsonResponse(400, {
            success: false,
            error: 'Missing url parameter'
        });
    }

    try {
        const safeTargetUrl = validateTargetUrl(targetUrl);

        const response = await axios.get(safeTargetUrl, {
            timeout: 7000,
            maxRedirects: 0,
            maxContentLength: 5 * 1024 * 1024,
            maxBodyLength: 5 * 1024 * 1024,
            responseType: 'text',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'ru-RU,ru;q=0.9'
            }
        });

        const $ = cheerio.load(response.data);

        // Extract exploded-view image URL.
        let schemeImage = '';
        const imgTag = $('img[usemap], #viewport img, .scheme-img, #img_div img').first();

        if (imgTag.length) {
            schemeImage = imgTag.attr('src') || '';

            if (schemeImage) {
                try {
                    schemeImage = new URL(schemeImage, safeTargetUrl).toString();
                } catch {
                    schemeImage = '';
                }
            }
        }

        // Extract parts table data.
        const parts = [];
        $('tr').each((index, element) => {
            const row = $(element);
            const oemLink = row.find('a[href*="oem"], a[href*="part"]').first();

            if (oemLink.length) {
                const rawOem = oemLink.text().trim();
                const cleanedOem = cleanSku(rawOem);

                if (cleanedOem) {
                    const cells = row.find('td');
                    const pos = cells.first().text().trim();
                    let name = cells.eq(2).text().trim() ||
                        cells.last().text().trim();

                    name = name.replace(/\s+/g, ' ');

                    parts.push({
                        cleaned_oem: cleanedOem,
                        raw_oem: rawOem,
                        pos: pos || '—',
                        name: name || 'Деталь'
                    });
                }
            }
        });

        return jsonResponse(200, {
            success: true,
            scheme_image: schemeImage,
            parts
        });
    } catch (error) {
        const message = error && error.message
            ? error.message
            : 'Unknown error';

        const isTargetValidationError =
            message === 'Invalid target URL' ||
            message === 'Only HTTPS target URLs are allowed' ||
            message === 'Target host is not allowed' ||
            message === 'Credentials and custom ports are not allowed';

        return jsonResponse(isTargetValidationError ? 400 : 502, {
            success: false,
            error: isTargetValidationError
                ? message
                : 'Proxy failed to fetch target: ' + message
        });
    }
};
