import { useState } from "react";

async function fetchRedditPosts(query, limit = 100) {
  const results = [];
  const seen = new Set();
  const subreddits = ["all", "browsers", "software"];
  for (const sub of subreddits) {
    try {
      const url =
        sub === "all"
          ? `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=${limit}&t=year`
          : `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&limit=${limit}&t=year`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await res.json();
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

async function fetchHackerNewsPosts(query, limit = 100) {
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment,story&hitsPerPage=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
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

async function fetchDevToPosts(query, limit = 100) {
  try {
    const url = `https://dev.to/api/articles?tag=${encodeURIComponent(query.split(" ")[0].toLowerCase())}&per_page=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return (data || []).map((a) => ({
      site: "DEV.to",
      source: "DEV.to",
      title: a.title || "",
      text: (a.description || "").slice(0, 400),
    }));
  } catch {
    return [];
  }
}

async function gatherAllData(query) {
  const [reddit, hn, devto] = await Promise.all([
    fetchRedditPosts(query),
    fetchHackerNewsPosts(query),
    fetchDevToPosts(query),
  ]);
  return [...reddit, ...hn, ...devto];
}

// Numbers posts for citation and stops at a whole-post boundary once maxChars
// is reached, so the model is only ever shown complete posts and told exactly
// how many were left out.
function buildPromptData(posts, maxChars = 20000) {
  const eligible = posts.filter((p) => p.title || p.text);
  const lines = [];
  const includedPosts = [];
  let totalChars = 0;
  for (const p of eligible) {
    const line = `[${includedPosts.length + 1}] [${p.source}] ${p.title}${p.text ? ": " + p.text : ""}`;
    if (totalChars + line.length + 1 > maxChars) break;
    lines.push(line);
    includedPosts.push(p);
    totalChars += line.length + 1;
  }
  const bySite = {};
  for (const p of includedPosts) bySite[p.site] = (bySite[p.site] || 0) + 1;
  return {
    text: lines.join("\n"),
    includedCount: includedPosts.length,
    omittedCount: eligible.length - includedPosts.length,
    bySite,
  };
}

// Keeps only items the model backed with a citation into the numbered posts
// we actually sent it, so unfounded claims never reach the UI.
function groundedItems(items, includedCount) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    const text = typeof item === "string" ? item : item?.text;
    const citedPostIds = Array.isArray(item?.citedPostIds) ? item.citedPostIds : [];
    const grounded =
      citedPostIds.length > 0 &&
      citedPostIds.every((id) => Number.isInteger(id) && id >= 1 && id <= includedCount);
    if (text && grounded) out.push(text);
  }
  return out;
}

function finalizeProduct(raw, built) {
  return {
    name: raw?.name,
    sentimentScore: raw?.sentimentScore ?? 0,
    positive: raw?.positive ?? 0,
    neutral: raw?.neutral ?? 0,
    negative: raw?.negative ?? 0,
    insufficientData: Boolean(raw?.insufficientData) || built.includedCount === 0,
    summary: raw?.summary || "",
    topPraises: groundedItems(raw?.topPraises, built.includedCount),
    topComplaints: groundedItems(raw?.topComplaints, built.includedCount),
    topThemes: groundedItems(raw?.topThemes, built.includedCount),
    dataPoints: built.includedCount,
    sourceBreakdown: built.bySite,
  };
}

async function analyzeWithClaude(productA, productB, dataA, dataB, focus) {
  const A = buildPromptData(dataA);
  const B = buildPromptData(dataB);

  if (A.includedCount === 0 && B.includedCount === 0) {
    throw new Error("No posts were found for either product. Try different search terms.");
  }

  const prompt = `You are a senior product analyst. Analyze user sentiment from Reddit, Hacker News, and DEV.to posts for two competing products.

Base your analysis strictly on the numbered posts provided below — do not supplement with general knowledge about these products. For every entry in topPraises, topComplaints, and topThemes, cite the post numbers (citedPostIds) that actually support it; never invent a citation. If a product has too few posts to support a confident analysis, set insufficientData to true for it, leave its topPraises/topComplaints/topThemes empty, and say so plainly in the summary instead of guessing.

Product A: ${productA}
Product B: ${productB}
Focus area: ${focus || "general user experience"}

Data about ${productA} (${A.includedCount} posts included${A.omittedCount > 0 ? `, ${A.omittedCount} more fetched but omitted for length` : ""}):
${A.text || "(no posts found)"}

Data about ${productB} (${B.includedCount} posts included${B.omittedCount > 0 ? `, ${B.omittedCount} more fetched but omitted for length` : ""}):
${B.text || "(no posts found)"}

Respond ONLY with a JSON object, no preamble or markdown:
{
  "productA": {
    "name": "${productA}",
    "sentimentScore": <0-100>,
    "positive": <0-100>,
    "neutral": <0-100>,
    "negative": <0-100>,
    "insufficientData": <true|false>,
    "topPraises": [{"text": "<phrase>", "citedPostIds": [<post number>, ...]}],
    "topComplaints": [{"text": "<phrase>", "citedPostIds": [<post number>, ...]}],
    "topThemes": [{"text": "<theme>", "citedPostIds": [<post number>, ...]}],
    "summary": "<2 sentence summary>"
  },
  "productB": {
    "name": "${productB}",
    "sentimentScore": <0-100>,
    "positive": <0-100>,
    "neutral": <0-100>,
    "negative": <0-100>,
    "insufficientData": <true|false>,
    "topPraises": [{"text": "<phrase>", "citedPostIds": [<post number>, ...]}],
    "topComplaints": [{"text": "<phrase>", "citedPostIds": [<post number>, ...]}],
    "topThemes": [{"text": "<theme>", "citedPostIds": [<post number>, ...]}],
    "summary": "<2 sentence summary>"
  },
  "competitive": {
    "winnerA": "<area where A wins>",
    "winnerB": "<area where B wins>",
    "unmetNeed": "<biggest unmet user need>",
    "opportunity": "<key product opportunity>"
  }
}`;

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }

  const data = await res.json();
  const text = data.content.map((i) => i.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  return {
    productA: finalizeProduct(parsed.productA, A),
    productB: finalizeProduct(parsed.productB, B),
    competitive: parsed.competitive,
  };
}

const getScoreLabel = (s) =>
  s >= 70 ? "Positive" : s >= 45 ? "Mixed" : "Negative";

const getScoreColor = (s) =>
  s >= 70 ? "#16a34a" : s >= 45 ? "#d97706" : "#dc2626";

const ScoreRing = ({ score, label }) => {
  const r = 36, circ = 2 * Math.PI * r, dash = (score / 100) * circ;
  const color = getScoreColor(score);
  return (
    <div style={{ textAlign: "center" }}>
      <svg width="90" height="90" viewBox="0 0 90 90" role="img" aria-label={`${label}: ${score}/100 — ${getScoreLabel(score)}`}>
        <circle cx="45" cy="45" r={r} fill="none" stroke="#e2e8f0" strokeWidth="7" />
        <circle cx="45" cy="45" r={r} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 45 45)" style={{ transition: "stroke-dasharray 1s ease" }} />
        <text x="45" y="46" textAnchor="middle" fill="#0f172a" fontSize="15" fontWeight="700">{score}</text>
        <text x="45" y="60" textAnchor="middle" fill="#64748b" fontSize="8">/100</text>
      </svg>
      <div style={{ fontSize: "10px", color, fontWeight: "600", marginTop: "2px", letterSpacing: "0.05em" }}>
        {getScoreLabel(score).toUpperCase()}
      </div>
    </div>
  );
};

const SentimentBar = ({ positive, neutral, negative }) => (
  <div>
    <div style={{ display: "flex", borderRadius: "6px", overflow: "hidden", height: "22px", gap: "2px" }}>
      <div style={{ width: `${positive}%`, background: "#16a34a", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minWidth: positive > 0 ? "4px" : "0", transition: "width 1s ease" }}>
        {positive >= 12 && <span style={{ fontSize: "10px", color: "#fff", fontWeight: "700" }}>{positive}%</span>}
      </div>
      <div style={{ width: `${neutral}%`, background: "#f59e0b", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minWidth: neutral > 0 ? "4px" : "0", transition: "width 1s ease" }}>
        {neutral >= 12 && <span style={{ fontSize: "10px", color: "#fff", fontWeight: "700" }}>{neutral}%</span>}
      </div>
      <div style={{ width: `${negative}%`, background: "#dc2626", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minWidth: negative > 0 ? "4px" : "0", transition: "width 1s ease" }}>
        {negative >= 12 && <span style={{ fontSize: "10px", color: "#fff", fontWeight: "700" }}>{negative}%</span>}
      </div>
    </div>
    <div style={{ display: "flex", gap: "16px", marginTop: "8px", flexWrap: "wrap" }}>
      {[{ symbol: "▲", label: "Positive", value: positive, color: "#16a34a" }, { symbol: "◆", label: "Neutral", value: neutral, color: "#d97706" }, { symbol: "▼", label: "Negative", value: negative, color: "#dc2626" }].map((item) => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span style={{ fontSize: "10px", color: item.color }}>{item.symbol}</span>
          <span style={{ fontSize: "11px", color: "#475569" }}>{item.label}: <strong style={{ color: "#0f172a" }}>{item.value}%</strong></span>
        </div>
      ))}
    </div>
  </div>
);

const Tag = ({ text, type }) => {
  const config = {
    praise:    { symbol: "✓", prefix: "Praise",    bg: "#dcfce7", color: "#166534", border: "#86efac" },
    complaint: { symbol: "✗", prefix: "Complaint", bg: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
    theme:     { symbol: "#", prefix: "Theme",     bg: "#ede9fe", color: "#5b21b6", border: "#c4b5fd" },
  };
  const c = config[type];
  return (
    <span style={{ background: c.bg, color: c.color, border: `1px solid ${c.border}`, borderRadius: "4px", padding: "4px 10px", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "5px", margin: "3px", fontWeight: "500" }} aria-label={`${c.prefix}: ${text}`}>
      <span style={{ fontSize: "11px" }}>{c.symbol}</span>
      {text}
    </span>
  );
};

const ProductCard = ({ data, label }) => (
  <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "16px", padding: "28px", flex: 1, minWidth: "280px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
      <div>
        <div style={{ fontSize: "10px", color: "#64748b", letterSpacing: "0.1em", marginBottom: "4px", fontWeight: "600" }}>{label}</div>
        <h2 style={{ color: "#0f172a", fontSize: "18px", fontWeight: "700", margin: 0 }}>{data.name}</h2>
      </div>
      <ScoreRing score={data.sentimentScore} label={data.name} />
    </div>
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "16px", alignItems: "center" }}>
      <span style={{ fontSize: "10px", color: "#64748b", fontWeight: "600" }}>{data.dataPoints} POSTS REFERENCED:</span>
      {["Reddit", "Hacker News", "DEV.to"].map((s) => (
        <span key={s} style={{ background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: "4px", padding: "2px 8px", fontSize: "10px", color: "#475569", fontWeight: "500" }}>{s}: {data.sourceBreakdown?.[s] || 0}</span>
      ))}
    </div>
    {data.insufficientData && (
      <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: "8px", padding: "8px 12px", marginBottom: "16px", fontSize: "11px", color: "#92400e", fontWeight: "600" }}>
        ⚠ Not enough posts were found for this product — treat this analysis with caution.
      </div>
    )}
    <p style={{ color: "#475569", fontSize: "13px", lineHeight: "1.7", marginBottom: "24px" }}>{data.summary}</p>
    <div style={{ marginBottom: "20px" }}>
      <div style={{ color: "#64748b", fontSize: "11px", fontWeight: "600", marginBottom: "10px" }}>SENTIMENT BREAKDOWN</div>
      <SentimentBar positive={data.positive} neutral={data.neutral} negative={data.negative} />
    </div>
    <div style={{ marginBottom: "16px" }}>
      <p style={{ color: "#16a34a", fontSize: "11px", fontWeight: "600", marginBottom: "8px" }}>✓ USERS LOVE</p>
      <div>
        {data.topPraises.length
          ? data.topPraises.map((p, i) => <Tag key={i} text={p} type="praise" />)
          : <span style={{ fontSize: "12px", color: "#94a3b8" }}>No verified praises found</span>}
      </div>
    </div>
    <div style={{ marginBottom: "16px" }}>
      <p style={{ color: "#dc2626", fontSize: "11px", fontWeight: "600", marginBottom: "8px" }}>✗ PAIN POINTS</p>
      <div>
        {data.topComplaints.length
          ? data.topComplaints.map((c, i) => <Tag key={i} text={c} type="complaint" />)
          : <span style={{ fontSize: "12px", color: "#94a3b8" }}>No verified complaints found</span>}
      </div>
    </div>
    <div>
      <p style={{ color: "#5b21b6", fontSize: "11px", fontWeight: "600", marginBottom: "8px" }}># TOP THEMES</p>
      <div>
        {data.topThemes.length
          ? data.topThemes.map((t, i) => <Tag key={i} text={t} type="theme" />)
          : <span style={{ fontSize: "12px", color: "#94a3b8" }}>No verified themes found</span>}
      </div>
    </div>
  </div>
);

export default function App() {
  const [productA, setProductA] = useState("");
  const [productB, setProductB] = useState("");
  const [focus, setFocus] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState("");
  const [dataStats, setDataStats] = useState(null);

  async function handleAnalyze() {
    if (!productA || !productB) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setDataStats(null);
    try {
      const queryA = focus ? `${productA} ${focus}` : productA;
      const queryB = focus ? `${productB} ${focus}` : productB;
      setStage(`Gathering data for ${productA}...`);
      const dataA = await gatherAllData(queryA);
      setStage(`Gathering data for ${productB}...`);
      const dataB = await gatherAllData(queryB);
      setDataStats({ a: dataA.length, b: dataB.length });
      setStage("Analyzing with Claude...");
      const analysis = await analyzeWithClaude(productA, productB, dataA, dataB, focus);
      setResults(analysis);
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
      setStage("");
    }
  }

  const inputStyle = { width: "100%", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "10px", padding: "12px 16px", color: "#0f172a", fontSize: "14px", fontFamily: "inherit" };
  const labelStyle = { color: "#334155", fontSize: "11px", fontWeight: "600", display: "block", marginBottom: "8px", letterSpacing: "0.05em" };

  return (
    <div style={{ minHeight: "100vh", background: "#f1f5f9", color: "#0f172a", padding: "40px 24px", fontFamily: "system-ui, sans-serif" }}>
      <style>{`
        * { box-sizing: border-box; }
        input, textarea { outline: none; }
        input::placeholder, textarea::placeholder { color: #94a3b8; }
        input:focus, textarea:focus { border-color: #6366f1 !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }
        .abtn:hover:not(:disabled) { background: #4338ca !important; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(79,70,229,0.3) !important; }
        .abtn:disabled { opacity: 0.4; cursor: not-allowed; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <div style={{ maxWidth: "1040px", margin: "0 auto" }}>
        <header style={{ textAlign: "center", marginBottom: "48px" }}>
          <div style={{ display: "inline-block", background: "#ede9fe", border: "1px solid #c4b5fd", borderRadius: "100px", padding: "6px 16px", marginBottom: "20px" }}>
            <span style={{ color: "#5b21b6", fontSize: "11px", fontWeight: "600", letterSpacing: "0.12em" }}>◆ SENTIMENT ANALYSIS ENGINE</span>
          </div>
          <h1 style={{ fontSize: "clamp(28px, 5vw, 48px)", fontWeight: "800", margin: "0 0 12px", color: "#0f172a" }}>Compare Any Two Products</h1>
          <p style={{ color: "#475569", fontSize: "15px", maxWidth: "520px", margin: "0 auto", lineHeight: "1.6" }}>
            Pulls real discussions from Reddit, Hacker News, and DEV.to — analyzed by Claude.
          </p>
          <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "14px", flexWrap: "wrap" }}>
            {["Reddit", "Hacker News", "DEV.to"].map((s) => (
              <span key={s} style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "100px", padding: "4px 12px", fontSize: "11px", color: "#475569", fontWeight: "500" }}>{s}</span>
            ))}
          </div>
        </header>
        <section style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "20px", padding: "32px", marginBottom: "32px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
          <div style={{ display: "flex", gap: "16px", marginBottom: "16px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "180px" }}>
              <label style={labelStyle}>PRODUCT A</label>
              <input value={productA} onChange={(e) => setProductA(e.target.value)} placeholder="e.g. Microsoft Edge AI" style={inputStyle} />
            </div>
            <div style={{ flex: 1, minWidth: "180px" }}>
              <label style={labelStyle}>PRODUCT B</label>
              <input value={productB} onChange={(e) => setProductB(e.target.value)} placeholder="e.g. Google Chrome AI" style={inputStyle} />
            </div>
            <div style={{ flex: 1, minWidth: "180px" }}>
              <label style={labelStyle}>FOCUS AREA <span style={{ color: "#94a3b8", fontWeight: "400" }}>(optional)</span></label>
              <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. AI features, privacy" style={inputStyle} />
            </div>
          </div>
          <button className="abtn" onClick={handleAnalyze} disabled={loading || !productA || !productB}
            style={{ width: "100%", background: "#4f46e5", border: "none", borderRadius: "10px", padding: "14px", color: "#ffffff", fontSize: "14px", fontWeight: "600", cursor: "pointer", transition: "all 0.2s ease", fontFamily: "inherit", boxShadow: "0 2px 8px rgba(79,70,229,0.2)" }}>
            {loading ? `⟳ ${stage}` : "Analyze Sentiment →"}
          </button>
          {loading && dataStats && (
            <div style={{ marginTop: "12px", textAlign: "center", fontSize: "12px", color: "#64748b" }}>
              Found {dataStats.a} posts for {productA} · {dataStats.b} posts for {productB}
            </div>
          )}
        </section>
        {error && (
          <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: "12px", padding: "16px", marginBottom: "24px", color: "#991b1b", fontSize: "14px", textAlign: "center", fontWeight: "500" }}>
            ✗ {error}
          </div>
        )}
        {results && (
          <main style={{ animation: "fadeIn 0.5s ease" }}>
            <div style={{ display: "flex", gap: "20px", marginBottom: "20px", flexWrap: "wrap" }}>
              <ProductCard data={results.productA} label="PRODUCT A" />
              <ProductCard data={results.productB} label="PRODUCT B" />
            </div>
            <section style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "16px", padding: "28px", marginBottom: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
              <h3 style={{ fontSize: "16px", color: "#0f172a", fontWeight: "700", marginTop: 0, marginBottom: "20px" }}>Competitive Insights</h3>
              <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
                {[
                  { label: `▲ WHERE ${results.productA.name.toUpperCase()} WINS`, value: results.competitive.winnerA, bg: "#f0fdf4", border: "#86efac", labelColor: "#16a34a" },
                  { label: `▲ WHERE ${results.productB.name.toUpperCase()} WINS`, value: results.competitive.winnerB, bg: "#eff6ff", border: "#93c5fd", labelColor: "#1d4ed8" },
                  { label: "◆ UNMET USER NEED", value: results.competitive.unmetNeed, bg: "#fffbeb", border: "#fcd34d", labelColor: "#d97706" },
                  { label: "★ KEY OPPORTUNITY", value: results.competitive.opportunity, bg: "#fdf4ff", border: "#e879f9", labelColor: "#a21caf" },
                ].map((item, i) => (
                  <div key={i} style={{ flex: 1, minWidth: "200px", background: item.bg, border: `1px solid ${item.border}`, borderRadius: "12px", padding: "16px" }}>
                    <p style={{ color: item.labelColor, fontSize: "10px", fontWeight: "700", margin: "0 0 8px", letterSpacing: "0.05em" }}>{item.label}</p>
                    <p style={{ color: "#1e293b", fontSize: "13px", margin: 0, lineHeight: "1.6" }}>{item.value}</p>
                  </div>
                ))}
              </div>
            </section>
            <section style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "16px", padding: "28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
              <h3 style={{ fontSize: "16px", color: "#0f172a", fontWeight: "700", marginTop: 0, marginBottom: "6px" }}>My Recommendations</h3>
              <p style={{ color: "#64748b", fontSize: "11px", fontWeight: "600", marginBottom: "14px", letterSpacing: "0.05em" }}>YOUR ANALYSIS BASED ON THE DATA ABOVE</p>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Based on the data, here's what I think the key opportunities are..." rows={5}
                style={{ ...inputStyle, resize: "vertical", lineHeight: "1.7" }} />
            </section>
          </main>
        )}
        <footer style={{ textAlign: "center", color: "#94a3b8", fontSize: "11px", marginTop: "40px", letterSpacing: "0.05em" }}>
          Built as a portfolio project
        </footer>
      </div>
    </div>
  );
}
