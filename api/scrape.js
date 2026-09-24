import axios from "axios";
import * as cheerio from "cheerio";

// List of invalid extensions and noise domains to reject
const BANNED_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", 
  ".avif", ".ico", ".css", ".js", ".bmp", ".tiff"
];

const BANNED_DOMAINS = [
  "sentry.io", "wixpress.com", "example.com", "domain.com", 
  "email.com", "yourdomain.com", "test.com", "google.com"
];

/**
 * Validates whether a candidate string is an actual email
 */
function isValidEmail(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  const clean = candidate.trim().toLowerCase();

  // Basic regex check
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!regex.test(clean)) return false;

  // Filter out image filenames like logo@2x.png
  for (const ext of BANNED_EXTENSIONS) {
    if (clean.endsWith(ext)) return false;
  }

  // Filter out banned/dummy domains
  const domainPart = clean.split("@")[1];
  if (!domainPart || BANNED_DOMAINS.includes(domainPart)) return false;

  // Filter out invalid length or strange artifacts
  if (clean.length > 80 || clean.length < 5) return false;

  return true;
}

/**
 * Extracts emails from clean text and mailto links using Cheerio DOM
 */
function extractEmailsFromDom($) {
  const foundEmails = new Set();

  // 1. Priority: Find mailto: links in <a> tags
  $('a[href^="mailto:"]').each((_, el) => {
    let href = $(el).attr("href") || "";
    let email = href.replace(/^mailto:/i, "").split("?")[0].trim();
    if (isValidEmail(email)) {
      foundEmails.add(email.toLowerCase());
    }
  });

  // 2. Strip noise elements before reading page text
  $("script, style, noscript, svg, code, pre, img, video, audio").remove();

  // 3. Extract text from body and run regex
  const text = $("body").text() || "";
  const broadRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(broadRegex) || [];

  for (const m of matches) {
    if (isValidEmail(m)) {
      foundEmails.add(m.toLowerCase());
    }
  }

  return Array.from(foundEmails);
}

/**
 * Helper to fetch HTML with a browser User-Agent
 */
async function fetchUrlHtml(url) {
  const res = await axios.get(url, {
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    validateStatus: (status) => status >= 200 && status < 400
  });
  return typeof res.data === "string" ? res.data : "";
}

/**
 * Find internal links for contact, about, team, imprint pages
 */
function findContactLinks(baseUrl, $) {
  const links = new Set();
  const keywords = ["contact", "about", "team", "imprint", "reach", "help"];

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

    const lower = href.toLowerCase();
    const hasKeyword = keywords.some(k => lower.includes(k));

    if (hasKeyword) {
      try {
        const fullUrl = new URL(href, baseUrl);
        // Only crawl links on the same host/domain
        if (fullUrl.hostname === new URL(baseUrl).hostname) {
          links.add(fullUrl.href);
        }
      } catch (e) {
        // ignore invalid URLs
      }
    }
  });

  // Limit to top 3 relevant pages to prevent timeout
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
        timeout: 10000
      }
    );
    const items = res.data?.organic || [];
    const combined = items.map((it) => `${it.title || ""} ${it.snippet || ""}`).join(" ");
    const matches = combined.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    return matches.filter(isValidEmail).map(e => e.toLowerCase());
  } catch (e) {
    return [];
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Only GET allowed. Use /api/scrape?url=..." });
    }

    const target = req.query.url;
    if (!target) return res.status(400).json({ error: "Missing ?url= parameter" });

    let targetUrl;
    try {
      targetUrl = new URL(target).href;
    } catch (e) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    let allEmails = new Set();

    // 1) Fetch and inspect homepage
    let homepageHtml = "";
    try {
      homepageHtml = await fetchUrlHtml(targetUrl);
    } catch (err) {
      return res.status(200).json({ url: targetUrl, emails: [] });
    }

    const $ = cheerio.load(homepageHtml);
    const homeEmails = extractEmailsFromDom($);
    homeEmails.forEach(e => allEmails.add(e));

    // 2) If no valid emails found on homepage, crawl contact & about pages
    if (allEmails.size === 0) {
      const contactPages = findContactLinks(targetUrl, $);
      for (const pageUrl of contactPages) {
        try {
          const pageHtml = await fetchUrlHtml(pageUrl);
          const page$ = cheerio.load(pageHtml);
          const pageEmails = extractEmailsFromDom(page$);
          pageEmails.forEach(e => allEmails.add(e));
          if (allEmails.size > 0) break; // Found emails, stop crawling
        } catch (e) {
          // ignore page fetch error and try next
        }
      }
    }

    // 3) Fallback: Serper search if still empty and key is present
    if (allEmails.size === 0 && process.env.SERPER_API_KEY) {
      const domain = new URL(targetUrl).hostname;
      const serperEmails = await serperFallback(domain, process.env.SERPER_API_KEY);
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
