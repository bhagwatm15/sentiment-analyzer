// Reddit's anonymous .json endpoints block requests from cloud/serverless IP
// ranges (including Vercel's) with a 403 bot-detection page, regardless of
// headers. The OAuth API (oauth.reddit.com) is not subject to that wall.
// Requires REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET from a Reddit "script" app
// (reddit.com/prefs/apps), set as Vercel environment variables.

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set");
  }

  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "sentiment-analyzer/1.0 (Vercel serverless function)",
    },
    body: "grant_type=client_credentials",
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`token request failed: HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  const data = JSON.parse(bodyText);
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const query = typeof req.query.query === "string" ? req.query.query : "";
  const limit = Number(req.query.limit) || 100;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter" });
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.error(`[api/reddit] auth failed: ${e.message}`);
    return res.status(200).json([]);
  }

  const results = [];
  const seen = new Set();
  const subreddits = ["all", "browsers", "software"];

  for (const sub of subreddits) {
    try {
      const url =
        sub === "all"
          ? `https://oauth.reddit.com/search?q=${encodeURIComponent(query)}&sort=relevance&limit=${limit}&t=year`
          : `https://oauth.reddit.com/r/${sub}/search?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&limit=${limit}&t=year`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
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
