import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Only GET requests allowed" });
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    // Fetch target page
    const { data } = await axios.get(targetUrl, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    // Load HTML
    const $ = cheerio.load(data);

    // Find emails using regex
    const pageText = $("body").text();
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g;
    const emails = pageText.match(emailRegex) || [];

    res.status(200).json({
      url: targetUrl,
      emails: [...new Set(emails)] // unique emails only
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to scrape",
      details: error.message
    });
  }
}
