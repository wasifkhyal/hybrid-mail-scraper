import axios from "axios";
import * as cheerio from "cheerio";

/**
 * API endpoint (Vercel): GET /api/scrape?url=<encoded-url>
 * - Primary: scrape homepage for emails (cheerio + regex)
 * - Secondary: if none, try /contact and /about pages
 * - Tertiary: if SERPER_API_KEY env var is present, query Serper.dev as fallback
 *
 * Response: { url: "...", emails: ["a@x.com","b@y.com"] }
 */

function extractEmailsFromText(text) {
  if (!text) return [];
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  return Array.from(new Set((text.match(regex) || []).map(s => s.trim())));
}

async function fetchUrlText(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; EmailScraper/1.0)" },
    validateStatus: status => status >= 200 && status < 400
  });
  return res.data;
}

async function tryContactPages(baseUrl, $homepage) {
  const hrefs = [];
  // look for likely contact/about links
  $homepage("a[href]").each((i, el) => {
    const href = $homepage(el).attr("href") || "";
    const low = href.toLowerCase();
    if (low.includes("contact") || low.includes("about") || low.includes("imprint") || low.includes("team")) {
      hrefs.push(href);
    }
  });

  // dedupe and normalize to absolute
  const uniq = Array.from(new Set(hrefs));
  const pages = [];
  for (const h of uniq) {
    try {
      const full = h.startsWith("http") ? h : new URL(h, baseUrl).href;
      pages.push(full);
    } catch (e) {
      // ignore bad hrefs
    }
  }
  return pages;
}

async function serperFallback(domain, apiKey) {
  if (!apiKey) return [];
  try {
    const body = { q: `site:${domain} email` };
    const r = await axios.post("https://google.serper.dev/search", body, {
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      timeout: 15000
    });
    const items = r.data?.organic || [];
    const combined = items.map(it => `${it.title || ""} ${it.snippet || ""}`).join(" ");
    return extractEmailsFromText(combined);
  } catch (e) {
    // if Serper fails, ignore
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

    let url;
    try { url = new URL(target).href; } catch (e) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    // 1) Try homepage
    let html;
    try {
      html = await fetchUrlText(url);
    } catch (err) {
      // network issue
      return res.status(500).json({ error: "Failed to fetch target", details: err.message });
    }

    let emails = extractEmailsFromText(html);
    if (emails.length > 0) {
      return res.status(200).json({ url, emails });
    }

    // 2) Parse homepage to find contact-like pages and check them
    const $ = cheerio.load(html);
    const contactPages = await tryContactPages(url, $);
    for (const p of contactPages) {
      try {
        const ph = await fetchUrlText(p);
        const found = extractEmailsFromText(ph);
        if (found.length > 0) {
          emails = emails.concat(found);
          break;
        }
      } catch (e) {
        // ignore page-level errors
      }
    }
    emails = Array.from(new Set(emails));
    if (emails.length > 0) return res.status(200).json({ url, emails });

    // 3) Optional fallback: Serper.dev search results (requires SERPER_API_KEY env var)
    const serperKey = process.env.SERPER_API_KEY || "";
    if (serperKey) {
      const domain = new URL(url).hostname;
      const serperEmails = await serperFallback(domain, serperKey);
      if (serperEmails.length > 0) {
        emails = Array.from(new Set(serperEmails.concat(emails)));
        return res.status(200).json({ url, emails });
      }
    }

    // no emails found
    return res.status(200).json({ url, emails: [] });
  } catch (err) {
    // unexpected
    console.error("Unexpected error in scrape:", err);
    return res.status(500).json({ error: "Unexpected server error", details: err.message });
  }
}
