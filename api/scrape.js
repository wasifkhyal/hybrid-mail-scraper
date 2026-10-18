import axios from "axios";
import * as cheerio from "cheerio";

// File extensions and dummy domains to reject
const BANNED_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
  ".avif", ".ico", ".css", ".js", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".eot"
];

const BANNED_DOMAINS = [
  "sentry.io", "wixpress.com", "example.com", "domain.com",
  "email.com", "yourdomain.com", "test.com", "google.com",
  "github.com", "cloudflare.com"
];

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1"
};

/**
 * Cloudflare Email Protection XOR Decoder
 */
function decodeCloudflareEmail(encodedString) {
  if (!encodedString || typeof encodedString !== "string") return "";
  try {
    let email = "";
    const key = parseInt(encodedString.substr(0, 2), 16);
    for (let n = 2; n < encodedString.length; n += 2) {
      const charCode = parseInt(encodedString.substr(n, 2), 16) ^ key;
      email += String.fromCharCode(charCode);
    }
    return email.trim();
  } catch (e) {
    return "";
  }
}

function isValidEmail(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  const clean = candidate.trim().toLowerCase();

  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!regex.test(clean)) return false;

  for (const ext of BANNED_EXTENSIONS) {
    if (clean.endsWith(ext)) return false;
  }

  const domainPart = clean.split("@")[1];
  if (!domainPart || BANNED_DOMAINS.includes(domainPart)) return false;
  if (clean.length > 80 || clean.length < 6) return false;

  return true;
}

function extractEmailsFromDom($) {
  const foundEmails = new Set();

  // 1. Decode Cloudflare protected emails (data-cfemail)
  $("[data-cfemail]").each((_, el) => {
    const encoded = $(el).attr("data-cfemail");
    const decoded = decodeCloudflareEmail(encoded);
    if (isValidEmail(decoded)) {
      foundEmails.add(decoded.toLowerCase());
    }
  });

  // Decode Cloudflare href protection links
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const encoded = href.split("#")[1];
    const decoded = decodeCloudflareEmail(encoded);
    if (isValidEmail(decoded)) {
      foundEmails.add(decoded.toLowerCase());
    }
  });

  // 2. Extract from standard mailto: links
  $('a[href*="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/mailto:([^?&"'>\s]+)/i);
    if (match && match[1]) {
      let email = decodeURIComponent(match[1]).replace(/[.,;:!?)'"\\]+$/, "").trim().toLowerCase();
      if (isValidEmail(email)) {
        foundEmails.add(email);
      }
    }
  });

  // 3. Remove non-visible/noisy elements
  $("script, style, noscript, svg, code, pre, img, video, audio").remove();

  // 4. Scan visible text with unmasking for [at] / (at) / [dot]
  let text = $("body").text() || "";
  text = text.replace(/\s*(\[at\]|\(at\))\s*/gi, "@")
             .replace(/\s*(\[dot\]|\(dot\))\s*/gi, ".");

  const broadRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(broadRegex) || [];

  for (let m of matches) {
    m = m.replace(/[.,;:!?)'"\\]+$/, "").trim().toLowerCase();
    if (isValidEmail(m)) {
      foundEmails.add(m);
    }
  }

  return Array.from(foundEmails);
}

async function fetchHtml(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: BROWSER_HEADERS,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400
    });
    return typeof res.data === "string" ? res.data : "";
  } catch (err) {
    if (url.startsWith("https://")) {
      try {
        const httpUrl = url.replace("https://", "http://");
        const res = await axios.get(httpUrl, {
          timeout: 8000,
          headers: BROWSER_HEADERS,
          maxRedirects: 5,
          validateStatus: (status) => status >= 200 && status < 400
        });
        return typeof res.data === "string" ? res.data : "";
      } catch (e) {
        return "";
      }
    }
    return "";
  }
}

/**
 * Finds contact, team, privacy, legal, and terms links
 */
function findContactAndLegalLinks(baseUrl, $) {
  const contactLinks = new Set();
  const legalLinks = new Set();

  const contactKeywords = ["contact", "about", "team", "reach", "help", "support", "imprint", "press"];
  const legalKeywords = ["privacy", "terms", "legal", "compliance", "policy"];

  const baseObj = new URL(baseUrl);

  $("a").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const text = ($(el).text() || "").toLowerCase().trim();

    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;

    const lowerHref = href.toLowerCase();

    // Check contact match
    if (contactKeywords.some(k => lowerHref.includes(k) || text.includes(k))) {
      try {
        const fullUrl = new URL(href, baseUrl);
        if (fullUrl.hostname === baseObj.hostname) contactLinks.add(fullUrl.href);
      } catch (e) {}
    }

    // Check privacy / legal match
    if (legalKeywords.some(k => lowerHref.includes(k) || text.includes(k))) {
      try {
        const fullUrl = new URL(href, baseUrl);
        if (fullUrl.hostname === baseObj.hostname) legalLinks.add(fullUrl.href);
      } catch (e) {}
    }
  });

  // Prioritize contact pages first, followed by legal/privacy pages
  const combined = [...Array.from(contactLinks).slice(0, 2), ...Array.from(legalLinks).slice(0, 2)];

  // Fallback direct routes if nothing was discovered in the HTML
  if (combined.length === 0) {
    combined.push(`${baseObj.origin}/contact`);
    combined.push(`${baseObj.origin}/about`);
    combined.push(`${baseObj.origin}/privacy`);
    combined.push(`${baseObj.origin}/privacy-policy`);
  }

  return combined.slice(0, 4);
}

async function serperFallback(domain, apiKey) {
  if (!apiKey) return [];
  try {
    const res = await axios.post(
      "https://google.serper.dev/search",
      { q: `site:${domain} email` },
      {
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        timeout: 8000
      }
    );
    const items = res.data?.organic || [];
    const combined = items.map((it) => `${it.title || ""} ${it.snippet || ""}`).join(" ");
    const matches = combined.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    return matches.map(m => m.replace(/[.,;:!?)'"\\]+$/, "").trim().toLowerCase()).filter(isValidEmail);
  } catch (e) {
    return [];
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Only GET allowed. Use /api/scrape?url=..." });
    }

    let rawUrl = (req.query.url || "").trim();
    if (!rawUrl) return res.status(400).json({ error: "Missing ?url= parameter" });

    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
      rawUrl = "https://" + rawUrl;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch (e) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const targetUrl = parsedUrl.href;
    const allEmails = new Set();
    let pageTitle = "";
    let pageSnippet = "";

    // 1) Fetch homepage
    const homeHtml = await fetchHtml(targetUrl);
    if (homeHtml) {
      const $ = cheerio.load(homeHtml);

      pageTitle = (
        $('meta[property="og:title"]').attr("content") ||
        $("title").text() ||
        $('meta[name="twitter:title"]').attr("content") ||
        ""
      ).trim();

      pageSnippet = (
        $('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        $('meta[name="twitter:description"]').attr("content") ||
        ""
      ).trim();

      pageTitle = pageTitle.replace(/\s+/g, " ").substring(0, 300);
      pageSnippet = pageSnippet.replace(/\s+/g, " ").substring(0, 500);

      const homeEmails = extractEmailsFromDom($);
      homeEmails.forEach(e => allEmails.add(e));

      // 2) If no emails on homepage, crawl contact & legal pages
      if (allEmails.size === 0) {
        const candidatePages = findContactAndLegalLinks(targetUrl, $);
        for (const pageUrl of candidatePages) {
          const pageHtml = await fetchHtml(pageUrl);
          if (pageHtml) {
            const page$ = cheerio.load(pageHtml);
            const pageEmails = extractEmailsFromDom(page$);
            pageEmails.forEach(e => allEmails.add(e));
            if (allEmails.size > 0) break; // Found email, stop crawling
          }
        }
      }
    }

    // 3) Fallback: Serper search if still empty and key is present
    if (allEmails.size === 0 && process.env.SERPER_API_KEY) {
      const serperEmails = await serperFallback(parsedUrl.hostname, process.env.SERPER_API_KEY);
      serperEmails.forEach(e => allEmails.add(e));
    }

    // Exact response schema preserved
    return res.status(200).json({
      url: targetUrl,
      emails: Array.from(allEmails),
      title: pageTitle,
      snippet: pageSnippet
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
