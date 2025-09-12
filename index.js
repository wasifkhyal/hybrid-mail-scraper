const express = require("express");
const app = express();

app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.send("API is running on Vercel!");
});

// Example scrape route
app.post("/scrape", (req, res) => {
  const { url } = req.body;
  // For now just return dummy
  res.json({ url, emails: ["test@example.com"] });
});

module.exports = app;
