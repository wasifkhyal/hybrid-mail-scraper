import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const emails = [];
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const found = data.match(regex);

    if (found) {
      found.forEach((email) => {
        if (!emails.includes(email)) emails.push(email);
      });
    }

    res.status(200).json({ url, emails });
  } catch (err) {
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
}
