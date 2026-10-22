import http from "http";

const PORT = 3001;

// Reddit and Hacker News don't send CORS headers for third-party origins, so
// these are fetched here (server-side) rather than from the browser. Mirrors
// api/reddit.js and api/hn.js, which handle the same thing in production.
async function fetchRedditPosts(query, limit) {
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
          "User-Agent": "sentiment-analyzer/1.0 (local dev server)",
        },
      });
      const data = await response.json();
      for (const p of data?.data?.children || []) {
        if (seen.has(p.data.id)) continue;
        seen.add(p.data.id);
        results.push({
          site: "Reddit",
          source: `Reddit r/${p.data.subreddit}`,
          title: p.data.title,
          text: (p.data.selftext || "").slice(0, 400),
        });
      }
    } catch {}
  }
  return results;
}

async function fetchHackerNewsPosts(query, limit) {
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment,story&hitsPerPage=${limit}`;
    const response = await fetch(url);
    const data = await response.json();
    return (data?.hits || []).map((h) => ({
      site: "Hacker News",
      source: "Hacker News",
      title: h.title || h.story_title || "",
      text: (h.comment_text || h.story_text || "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
  } catch {
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, "http://localhost");

  if (req.method === "POST" && pathname === "/api/analyze") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body,
        });
        const data = await response.json();
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.method === "GET" && (pathname === "/api/reddit" || pathname === "/api/hn")) {
    const query = searchParams.get("query") || "";
    const limit = Number(searchParams.get("limit")) || 100;
    if (!query) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing query parameter" }));
    }
    const results = pathname === "/api/reddit"
      ? await fetchRedditPosts(query, limit)
      : await fetchHackerNewsPosts(query, limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
