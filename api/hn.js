export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const query = typeof req.query.query === "string" ? req.query.query : "";
  const limit = Number(req.query.limit) || 100;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter" });
  }

  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment,story&hitsPerPage=${limit}`;
    const response = await fetch(url);
    const bodyText = await response.text();

    if (!response.ok) {
      console.error(`[api/hn] HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
      return res.status(200).json([]);
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      console.error(`[api/hn] non-JSON response: ${bodyText.slice(0, 300)}`);
      return res.status(200).json([]);
    }

    const results = (data?.hits || []).map((h) => ({
      site: "Hacker News",
      source: "Hacker News",
      title: h.title || h.story_title || "",
      text: (h.comment_text || h.story_text || "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
    console.log(`[api/hn] query="${query}" -> HTTP ${response.status}, ${results.length} posts (nbHits=${data?.nbHits})`);
    return res.status(200).json(results);
  } catch (e) {
    console.error(`[api/hn] fetch threw: ${e.message}`);
    return res.status(200).json([]);
  }
}
