import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Only GET requests allowed" });
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing ?url= parameter" });
  }

  try {
    // 1️⃣ Fetch the page HTML
    const { data: html } = await axios.get(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EmailScraperBot/1.0)",
      },
    });

    // 2️⃣ Load into Cheerio
    const $ = cheerio.load(html);

    // 3️⃣ Extract emails from homepage
    let emails = [];
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g;
    const matches = html.match(regex);
    if (matches) {
      emails = [...new Set(matches)]; // remove duplicates
    }

    // 4️⃣ If no emails, try "contact" links
    if (emails.length === 0) {
      const contactLink = $("a[href*='contact']").attr("href");
      if (contactLink) {
        const fullContactUrl = contactLink.startsWith("http")
          ? contactLink
          : new URL(contactLink, targetUrl).href;

        const { data: contactHtml } = await axios.get(fullContactUrl);
        const contactMatches = contactHtml.match(regex);
        if (contactMatches) {
          emails = [...new Set(contactMatches)];
        }
      }
    }

    // 5️⃣ Return result
    return res.status(200).json({
      url: targetUrl,
      emails: emails,
    });
  } catch (error) {
    console.error("Scraper error:", error.message);
    return res.status(500).json({
      error: "Failed to scrape site",
      details: error.message,
    });
  }
}
