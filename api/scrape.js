import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const emails = [];
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = data.match(regex);
    if (matches) {
      emails.push(...new Set(matches));
    }

    res.status(200).json({ url, emails });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Scraping failed", details: error.message });
  }
}

