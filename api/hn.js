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
    const data = await response.json();
    const results = (data?.hits || []).map((h) => ({
      site: "Hacker News",
      source: "Hacker News",
      title: h.title || h.story_title || "",
      text: (h.comment_text || h.story_text || "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
    return res.status(200).json(results);
  } catch {
    return res.status(200).json([]);
  }
}
