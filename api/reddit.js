export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const query = typeof req.query.query === "string" ? req.query.query : "";
  const limit = Number(req.query.limit) || 100;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter" });
  }

  const results = [];
  const seen = new Set();
  const subreddits = ["all", "browsers", "software"];

  for (const sub of subreddits) {
    try {
      const url =
        sub === "all"
          ? `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=${limit}&t=year`
          : `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&limit=${limit}&t=year`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "sentiment-analyzer/1.0 (Vercel serverless function)",
        },
      });
      const bodyText = await response.text();

      if (!response.ok) {
        console.error(`[api/reddit] r/${sub} -> HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
        continue;
      }

      let data;
      try {
        data = JSON.parse(bodyText);
      } catch {
        console.error(`[api/reddit] r/${sub} -> non-JSON response: ${bodyText.slice(0, 300)}`);
        continue;
      }

      const children = data?.data?.children || [];
      console.log(`[api/reddit] r/${sub} -> HTTP ${response.status}, ${children.length} raw hits`);
      for (const p of children) {
        if (seen.has(p.data.id)) continue;
        seen.add(p.data.id);
        results.push({
          site: "Reddit",
          source: `Reddit r/${p.data.subreddit}`,
          title: p.data.title,
          text: (p.data.selftext || "").slice(0, 400),
        });
      }
    } catch (e) {
      console.error(`[api/reddit] r/${sub} -> fetch threw: ${e.message}`);
    }
  }

  console.log(`[api/reddit] query="${query}" -> ${results.length} posts after dedup`);
  return res.status(200).json(results);
}
