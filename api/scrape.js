import axios from "axios";
import * as cheerio from "cheerio";

/**
 * API endpoint (Vercel): GET /api/scrape?url=<encoded-url>
 * Fixed: proper email validation + always crawl contact pages
 */

// File extensions that are NOT valid email TLDs
const BAD_TLDS = new Set([
  'webp','png','jpg','jpeg','gif','svg','ico','bmp',
  'pdf','zip','mp4','mp3','css','js','woff','ttf','eot','otf','webm','wav'
]);

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  email = email.trim();
  // Standard format check
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)) return false;
  const atIndex = email.lastIndexOf('@');
  const local   = email.substring(0, atIndex);
  const domain  = email.substring(atIndex + 1);
  // Local part length
  if (local.length < 1 || local.length > 64) return false;
  // No slashes or path separators
  if (/[\/\\]/.test(email)) return false;
  // Reject hash-like local parts (long hex strings = image asset names)
  if (/^[a-f0-9]{20,}$/i.test(local)) return false;
  // Reject hash-like domains (content-hash filenames)
  if (/^[a-f0-9\-]{30,}\./i.test(domain)) return false;
  // Check TLD is not a file extension
  const tldMatch = domain.match(/\.([a-zA-Z]{2,6})$/);
  if (!tldMatch) return false;
  if (BAD_TLDS.has(tldMatch[1].toLowerCase())) return false;
  return true;
}

function extractEmailsFromText(text) {
  if (!text) return [];
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const raw = (text.match(regex) || []).map(s => s.trim());
  return Array.from(new Set(raw.filter(isValidEmail)));
}

async function fetchUrlText(url, timeoutMs = 12000) {
  const res = await axios.get(url, {
    timeout: timeoutMs,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; EmailScraper/1.0)" },
    validateStatus: status => status >= 200 && status < 400
  });
  return res.data;
}

async function getContactPages(baseUrl, $homepage) {
  const hrefs = new Set();

  // Always try these common paths directly — many sites don't link them from homepage
  const commonPaths = [
    '/contact', '/contact-us', '/contact-us/',
    '/about', '/about-us', '/about-us/',
    '/team', '/imprint', '/legal', '/reach-us'
  ];
  for (const path of commonPaths) {
    try {
      hrefs.add(new URL(path, baseUrl).href);
    } catch (e) {}
  }

  // Also collect linked contact/about pages from homepage
  $homepage("a[href]").each((i, el) => {
    const href = ($homepage(el).attr("href") || "").toLowerCase();
    if (
      href.includes("contact") || href.includes("about") ||
      href.includes("imprint") || href.includes("team") ||
      href.includes("reach") || href.includes("legal")
    ) {
      try {
        const full = href.startsWith("http")
          ? href
          : new URL(href, baseUrl).href;
        hrefs.add(full);
      } catch (e) {}
    }
  });

  return Array.from(hrefs).slice(0, 8); // max 8 pages to stay within Vercel timeout
}

async function serperFallback(domain, apiKey) {
  if (!apiKey) return [];
  try {
    const r = await axios.post(
      "https://google.serper.dev/search",
      { q: `site:${domain} email` },
      {
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        timeout: 10000
      }
    );
    const items = r.data?.organic || [];
    const combined = items.map(it => `${it.title || ""} ${it.snippet || ""}`).join(" ");
    return extractEmailsFromText(combined);
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

    let url;
    try { url = new URL(target).href; } catch (e) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    // 1) Fetch homepage
    let html;
    try {
      html = await fetchUrlText(url);
    } catch (err) {
      return res.status(500).json({ error: "Failed to fetch target", details: err.message });
    }

    // 2) Always crawl contact/about pages regardless of homepage result
    //    This ensures we don't return only junk emails from homepage
    const $ = cheerio.load(html);
    const contactPages = await getContactPages(url, $);

    let allEmails = new Set(extractEmailsFromText(html));

    for (const page of contactPages) {
      try {
        const pageHtml = await fetchUrlText(page, 8000); // shorter timeout per subpage
        for (const e of extractEmailsFromText(pageHtml)) {
          allEmails.add(e);
        }
      } catch (e) {
        // page not found or timeout — skip silently
      }
    }

    const emails = Array.from(allEmails);
    if (emails.length > 0) return res.status(200).json({ url, emails });

    // 3) Serper fallback (only if API key set in Vercel env vars)
    const serperKey = process.env.SERPER_API_KEY || "";
    if (serperKey) {
      const domain = new URL(url).hostname;
      const serperEmails = await serperFallback(domain, serperKey);
      if (serperEmails.length > 0) {
        return res.status(200).json({ url, emails: serperEmails });
      }
    }

    return res.status(200).json({ url, emails: [] });

  } catch (err) {
    console.error("Unexpected error in scrape:", err);
    return res.status(500).json({ error: "Unexpected server error", details: err.message });
  }
}
