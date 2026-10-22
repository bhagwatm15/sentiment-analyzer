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
  return results;
}

async function fetchHackerNewsPosts(query, limit) {
  try {
    // "(comment,story)" is an OR across tags in Algolia's syntax; a bare
    // "comment,story" means AND, which no item can ever satisfy (nothing is
    // both a comment and a story) and silently returns zero hits forever.
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=${encodeURIComponent("(comment,story)")}&hitsPerPage=${limit}`;
    const response = await fetch(url);
    const bodyText = await response.text();
    if (!response.ok) {
      console.error(`[api/hn] HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
      return [];
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      console.error(`[api/hn] non-JSON response: ${bodyText.slice(0, 300)}`);
      return [];
    }
    const results = (data?.hits || []).map((h) => ({
      site: "Hacker News",
      source: "Hacker News",
      title: h.title || h.story_title || "",
      text: (h.comment_text || h.story_text || "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
    console.log(`[api/hn] query="${query}" -> HTTP ${response.status}, ${results.length} posts (nbHits=${data?.nbHits})`);
    return results;
  } catch (e) {
    console.error(`[api/hn] fetch threw: ${e.message}`);
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
