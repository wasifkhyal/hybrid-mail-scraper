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

// Full browser headers to prevent 403 Forbidden blocks
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
 * Validates whether candidate string is a real email
 */
function isValidEmail(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  const clean = candidate.trim().toLowerCase();

  // Basic regex check
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!regex.test(clean)) return false;

  // Filter out image/asset filenames (e.g. logo@2x.png)
  for (const ext of BANNED_EXTENSIONS) {
    if (clean.endsWith(ext)) return false;
  }

  // Filter out banned/dummy domains
  const domainPart = clean.split("@")[1];
  if (!domainPart || BANNED_DOMAINS.includes(domainPart)) return false;

  // Reject strings that are too long or too short
  if (clean.length > 80 || clean.length < 6) return false;

  return true;
}

/**
 * Extracts emails from clean Cheerio DOM
 */
function extractEmailsFromDom($) {
  const foundEmails = new Set();

  // 1. High priority: mailto links
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

  // 2. Remove script/style tags to avoid library and webpack noise
  $("script, style, noscript, svg, code, pre, img, video, audio").remove();

  // 3. Scan visible body text
  const text = $("body").text() || "";
  const broadRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(broadRegex) || [];

  for (let m of matches) {
    // Strip trailing punctuation often caught in sentences
    m = m.replace(/[.,;:!?)'"\\]+$/, "").trim().toLowerCase();
    if (isValidEmail(m)) {
      foundEmails.add(m);
    }
  }

  return Array.from(foundEmails);
}

/**
 * Fetch HTML safely with fallback to HTTP if HTTPS fails
 */
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
    // If https fails, try plain http once
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
 * Detect contact / about links in the page
 */
function findContactLinks(baseUrl, $) {
  const links = new Set();
  const keywords = ["contact", "about", "team", "reach", "help", "imprint", "support"];

  const baseObj = new URL(baseUrl);

  $("a").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const text = ($(el).text() || "").toLowerCase().trim();

    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      return;
    }

    const lowerHref = href.toLowerCase();
    const hasKeyword = keywords.some(k => lowerHref.includes(k) || text.includes(k));

    if (hasKeyword) {
      try {
        const fullUrl = new URL(href, baseUrl);
        if (fullUrl.hostname === baseObj.hostname) {
          links.add(fullUrl.href);
        }
      } catch (e) {
        // ignore malformed URLs
      }
    }
  });

  // If no contact links were in the HTML, try common standard routes
  if (links.size === 0) {
    links.add(`${baseObj.origin}/contact`);
    links.add(`${baseObj.origin}/about`);
  }

  // Limit to maximum 3 candidate pages to respect execution time
  return Array.from(links).slice(0, 3);
}

/**
 * Optional Serper fallback
 */
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
    if (!rawUrl) {
      return res.status(400).json({ error: "Missing ?url= parameter" });
    }

    // Ensure protocol is present
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

    // 1) Fetch and inspect homepage
    const homeHtml = await fetchHtml(targetUrl);
    if (homeHtml) {
      const $ = cheerio.load(homeHtml);
      const homeEmails = extractEmailsFromDom($);
      homeEmails.forEach(e => allEmails.add(e));

      // 2) If no email found on homepage, crawl contact & about pages
      if (allEmails.size === 0) {
        const candidatePages = findContactLinks(targetUrl, $);
        for (const pageUrl of candidatePages) {
          const pageHtml = await fetchHtml(pageUrl);
          if (pageHtml) {
            const page$ = cheerio.load(pageHtml);
            const pageEmails = extractEmailsFromDom(page$);
            pageEmails.forEach(e => allEmails.add(e));
            if (allEmails.size > 0) break; // Found emails, stop crawling
          }
        }
      }
    }

    // 3) Fallback: Serper search if still empty and key is present
    if (allEmails.size === 0 && process.env.SERPER_API_KEY) {
      const serperEmails = await serperFallback(parsedUrl.hostname, process.env.SERPER_API_KEY);
      serperEmails.forEach(e => allEmails.add(e));
    }

    return res.status(200).json({
      url: targetUrl,
      emails: Array.from(allEmails)
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
