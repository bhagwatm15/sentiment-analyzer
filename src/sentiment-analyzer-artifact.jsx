import { useState } from "react";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

async function fetchRedditPosts(query, limit = 100) {
  const results = [];
  const seen = new Set();
  const subreddits = ["all", "browsers", "software"];
  for (const sub of subreddits) {
    try {
      const url = sub === "all"
        ? `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=${limit}&t=year`
        : `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&limit=${limit}&t=year`;
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
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
    return (data?.hits || []).map(h => ({
      site: "Hacker News",
      source: "Hacker News",
      title: h.title || h.story_title || "",
      text: (h.comment_text || h.story_text || "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
  } catch { return []; }
}

async function fetchDevToPosts(query, limit = 100) {
  try {
    const url = `https://dev.to/api/articles?tag=${encodeURIComponent(query.split(" ")[0].toLowerCase())}&per_page=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return (data || []).map(a => ({
      site: "DEV.to",
      source: "DEV.to",
      title: a.title || "",
      text: (a.description || "").slice(0, 400),
    }));
  } catch { return []; }
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
  const eligible = posts.filter(p => p.title || p.text);
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
      citedPostIds.every(id => Number.isInteger(id) && id >= 1 && id <= includedCount);
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

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  const text = data.content.map(i => i.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  return {
    productA: finalizeProduct(parsed.productA, A),
    productB: finalizeProduct(parsed.productB, B),
    competitive: parsed.competitive,
  };
}

const getScoreLabel = (s) => s >= 70 ? "Positive" : s >= 45 ? "Mixed" : "Negative";

const ScoreRing = ({ score, label }) => {
  const r = 36, circ = 2 * Math.PI * r, dash = (score / 100) * circ;
  const colour = score >= 70 ? "#0f766e" : score >= 45 ? "#d97706" : "#e85d4a";
  return (
    <div style={{ textAlign: "center" }}>
      <svg width="90" height="90" viewBox="0 0 90 90" role="img" aria-label={`${label}: ${score}/100`}>
        <circle cx="45" cy="45" r={r} fill="none" stroke="#f1f5f9" strokeWidth="7" />
        <circle cx="45" cy="45" r={r} fill="none" stroke={colour} strokeWidth="7"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 45 45)" style={{ transition: "stroke-dasharray 1s ease" }} />
        <text x="45" y="46" textAnchor="middle" fill="#1a1208" fontSize="15" fontWeight="700">{score}</text>
        <text x="45" y="60" textAnchor="middle" fill="#6b5440" fontSize="8">/100</text>
      </svg>
      <div style={{ fontSize: "10px", color: "#6b5440", marginTop: "2px", letterSpacing: "0.05em" }}>{getScoreLabel(score).toUpperCase()}</div>
    </div>
  );
};

const SentimentBar = ({ positive, neutral, negative }) => (
  <div>
    <div style={{ display: "flex", borderRadius: "6px", overflow: "hidden", height: "22px", gap: "2px" }}>
      <div style={{ width: `${positive}%`, background: "#0f766e", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minWidth: positive > 0 ? "4px" : "0", transition: "width 1s ease" }}>
        {positive >= 12 && <span style={{ fontSize: "10px", color: "#fff", fontWeight: "700" }}>{positive}%</span>}
      </div>
      <div style={{ width: `${neutral}%`, background: "#e8ddd0", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minWidth: neutral > 0 ? "4px" : "0", transition: "width 1s ease" }}>
        {neutral >= 12 && <span style={{ fontSize: "10px", color: "#4a3520", fontWeight: "700" }}>{neutral}%</span>}
      </div>
      <div style={{ width: `${negative}%`, background: "#e85d4a", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minWidth: negative > 0 ? "4px" : "0", transition: "width 1s ease" }}>
        {negative >= 12 && <span style={{ fontSize: "10px", color: "#fff", fontWeight: "700" }}>{negative}%</span>}
      </div>
    </div>
    <div style={{ display: "flex", gap: "16px", marginTop: "8px", flexWrap: "wrap" }}>
      {[{ label: "Positive", value: positive, colour: "#0f766e" }, { label: "Neutral", value: neutral, colour: "#6b5440" }, { label: "Negative", value: negative, colour: "#e85d4a" }].map(item => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span style={{ fontSize: "11px", color: "#6b5440" }}>{item.label}: <strong style={{ color: item.colour }}>{item.value}%</strong></span>
        </div>
      ))}
    </div>
  </div>
);

const Tag = ({ text, type }) => {
  const config = {
    praise:    { symbol: "✓", bg: "#f0fdfa", color: "#0f766e", border: "#99e6df" },
    complaint: { symbol: "✗", bg: "#f0fdfa", color: "#0f766e", border: "#99e6df" },
    theme:     { symbol: "#", bg: "#f0fdfa", color: "#0f766e", border: "#99e6df" }
  };
  const c = config[type];
  return (
    <span style={{ background: c.bg, color: c.color, border: `1px solid ${c.border}`, borderRadius: "4px", padding: "4px 10px", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "5px", margin: "3px" }}>
      <span style={{ opacity: 0.7, fontSize: "11px" }}>{c.symbol}</span>{text}
    </span>
  );
};

const ProductCard = ({ data, label }) => (
  <div style={{ background: "#fafafa", border: "1px solid #e8ddd0", borderRadius: "16px", padding: "28px", flex: 1, minWidth: "280px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
      <div>
        <div style={{ fontSize: "10px", color: "#6b5440", letterSpacing: "0.1em", marginBottom: "4px", fontWeight: "600" }}>{label}</div>
        <h2 style={{ color: "#1a1208", fontSize: "18px", fontWeight: "700", margin: 0 }}>{data.name}</h2>
      </div>
      <ScoreRing score={data.sentimentScore} label={data.name} />
    </div>
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "16px", alignItems: "center" }}>
      <span style={{ fontSize: "10px", color: "#6b5440", fontWeight: "600" }}>{data.dataPoints} POSTS REFERENCED:</span>
      {["Reddit", "Hacker News", "DEV.to"].map(s => (
        <span key={s} style={{ background: "#fff", border: "1px solid #e8ddd0", borderRadius: "4px", padding: "2px 8px", fontSize: "10px", color: "#4a3520", fontWeight: "500" }}>{s}: {data.sourceBreakdown?.[s] || 0}</span>
      ))}
    </div>
    {data.insufficientData && (
      <div style={{ background: "#fff1ef", border: "1px solid #fcd0c8", borderRadius: "8px", padding: "8px 12px", marginBottom: "16px", fontSize: "11px", color: "#e85d4a", fontWeight: "600" }}>
        ⚠ Not enough posts were found for this product — treat this analysis with caution.
      </div>
    )}
    <p style={{ color: "#4a3520", fontSize: "13px", lineHeight: "1.7", marginBottom: "24px" }}>{data.summary}</p>
    <div style={{ marginBottom: "20px" }}>
      <div style={{ color: "#6b5440", fontSize: "11px", marginBottom: "10px", letterSpacing: "0.05em", fontWeight: "600" }}>SENTIMENT BREAKDOWN</div>
      <SentimentBar positive={data.positive} neutral={data.neutral} negative={data.negative} />
    </div>
    <div style={{ marginBottom: "16px" }}>
      <p style={{ color: "#6b5440", fontSize: "11px", marginBottom: "8px", fontWeight: "600" }}>✓ USERS LOVE</p>
      <div>
        {data.topPraises.length
          ? data.topPraises.map((p, i) => <Tag key={i} text={p} type="praise" />)
          : <span style={{ fontSize: "12px", color: "#c9b99a" }}>No verified praises found</span>}
      </div>
    </div>
    <div style={{ marginBottom: "16px" }}>
      <p style={{ color: "#6b5440", fontSize: "11px", marginBottom: "8px", fontWeight: "600" }}>✗ PAIN POINTS</p>
      <div>
        {data.topComplaints.length
          ? data.topComplaints.map((c, i) => <Tag key={i} text={c} type="complaint" />)
          : <span style={{ fontSize: "12px", color: "#c9b99a" }}>No verified complaints found</span>}
      </div>
    </div>
    <div>
      <p style={{ color: "#6b5440", fontSize: "11px", marginBottom: "8px", fontWeight: "600" }}># TOP THEMES</p>
      <div>
        {data.topThemes.length
          ? data.topThemes.map((t, i) => <Tag key={i} text={t} type="theme" />)
          : <span style={{ fontSize: "12px", color: "#c9b99a" }}>No verified themes found</span>}
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
    setLoading(true); setError(null); setResults(null); setDataStats(null);
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
      setError(e?.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false); setStage("");
    }
  }

  const inputStyle = {
    width: "100%", background: "#fff", border: "1px solid #e8ddd0",
    borderRadius: "10px", padding: "12px 16px", color: "#1a1208",
    fontSize: "14px", fontFamily: "inherit"
  };

  const labelStyle = {
    color: "#4a3520", fontSize: "11px", display: "block",
    marginBottom: "8px", letterSpacing: "0.05em", fontWeight: "600"
  };

  return (
    <div style={{ minHeight: "100vh", background: "#ffffff", color: "#1a1208", padding: "40px 24px", fontFamily: "system-ui, sans-serif" }}>
      <style>{`
        * { box-sizing: border-box; }
        input, textarea { outline: none; }
        input::placeholder, textarea::placeholder { color: #c9b99a; }
        input:focus, textarea:focus { border-color: #e85d4a !important; box-shadow: 0 0 0 3px rgba(232,93,74,0.1); }
        .abtn:hover:not(:disabled) { background: #d04a38 !important; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(232,93,74,0.3) !important; }
        .abtn:disabled { opacity: 0.4; cursor: not-allowed; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div style={{ maxWidth: "1040px", margin: "0 auto" }}>

        {/* Header */}
        <header style={{ textAlign: "center", marginBottom: "48px" }}>
          <h1 style={{ fontSize: "clamp(28px, 5vw, 48px)", fontWeight: "800", margin: "0 0 12px", color: "#1a1208", fontFamily: "system-ui, sans-serif" }}>
            Competitive Sentiment Analyser
          </h1>
          <p style={{ color: "#4a3520", fontSize: "15px", maxWidth: "520px", margin: "0 auto", lineHeight: "1.6" }}>
            Pulls real discussions from Reddit, Hacker News, and DEV.to and uses Claude to compare two competing products side by side.
          </p>
          <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "14px", flexWrap: "wrap" }}>
            {["Reddit", "Hacker News", "DEV.to"].map(s => (
              <span key={s} style={{ background: "#fafafa", border: "1px solid #e8ddd0", borderRadius: "100px", padding: "4px 14px", fontSize: "11px", color: "#4a3520", fontWeight: "500" }}>{s}</span>
            ))}
          </div>
        </header>

        {/* Inputs */}
        <section style={{ background: "#fafafa", border: "1px solid #e8ddd0", borderRadius: "20px", padding: "32px", marginBottom: "32px" }}>
          <div style={{ display: "flex", gap: "16px", marginBottom: "16px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "180px" }}>
              <label style={labelStyle}>PRODUCT A</label>
              <input value={productA} onChange={e => setProductA(e.target.value)} placeholder="e.g. Microsoft Edge AI" style={inputStyle} />
            </div>
            <div style={{ flex: 1, minWidth: "180px" }}>
              <label style={labelStyle}>PRODUCT B</label>
              <input value={productB} onChange={e => setProductB(e.target.value)} placeholder="e.g. Google Chrome AI" style={inputStyle} />
            </div>
            <div style={{ flex: 1, minWidth: "180px" }}>
              <label style={labelStyle}>FOCUS AREA <span style={{ color: "#c9b99a", fontWeight: "400" }}>(optional)</span></label>
              <input value={focus} onChange={e => setFocus(e.target.value)} placeholder="e.g. AI features, privacy" style={inputStyle} />
            </div>
          </div>
          <button className="abtn" onClick={handleAnalyze} disabled={loading || !productA || !productB}
            style={{ width: "100%", background: "#e85d4a", border: "none", borderRadius: "10px", padding: "14px", color: "#fff", fontSize: "14px", fontWeight: "600", cursor: "pointer", transition: "all 0.2s ease", fontFamily: "inherit" }}>
            {loading ? `⟳ ${stage}` : "Analyze Sentiment →"}
          </button>
          {loading && dataStats && (
            <div style={{ marginTop: "12px", textAlign: "center", fontSize: "12px", color: "#6b5440" }}>
              Found {dataStats.a} posts for {productA} · {dataStats.b} posts for {productB}
            </div>
          )}
        </section>

        {error && (
          <div role="alert" style={{ background: "#fff1ef", border: "1px solid #fcd0c8", borderRadius: "12px", padding: "16px", marginBottom: "24px", color: "#e85d4a", fontSize: "14px", textAlign: "center" }}>
            ✗ {error}
          </div>
        )}

        {results && (
          <main style={{ animation: "fadeIn 0.5s ease" }}>
            <div style={{ display: "flex", gap: "20px", marginBottom: "20px", flexWrap: "wrap" }}>
              <ProductCard data={results.productA} label="PRODUCT A" />
              <ProductCard data={results.productB} label="PRODUCT B" />
            </div>

            <section style={{ background: "#fafafa", border: "1px solid #e8ddd0", borderRadius: "16px", padding: "28px", marginBottom: "20px" }}>
              <h3 style={{ fontSize: "16px", color: "#1a1208", marginTop: 0, marginBottom: "20px", fontWeight: "700" }}>Competitive Insights</h3>
              <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
                {[
                  { label: `▲ WHERE ${results.productA.name.toUpperCase()} WINS`, value: results.competitive.winnerA, accent: "#e85d4a" },
                  { label: `▲ WHERE ${results.productB.name.toUpperCase()} WINS`, value: results.competitive.winnerB, accent: "#0f766e" },
                  { label: "◆ UNMET USER NEED", value: results.competitive.unmetNeed, accent: "#e85d4a" },
                  { label: "★ KEY OPPORTUNITY", value: results.competitive.opportunity, accent: "#0f766e" }
                ].map((item, i) => (
                  <div key={i} style={{ flex: 1, minWidth: "200px", background: "#fff", border: "1px solid #e8ddd0", borderLeft: `3px solid ${item.accent}`, borderRadius: "12px", padding: "16px" }}>
                    <p style={{ color: item.accent, fontSize: "10px", margin: "0 0 8px", letterSpacing: "0.05em", fontWeight: "700" }}>{item.label}</p>
                    <p style={{ color: "#2d1f0e", fontSize: "13px", margin: 0, lineHeight: "1.6" }}>{item.value}</p>
                  </div>
                ))}
              </div>
            </section>

            <section style={{ background: "#fafafa", border: "1px solid #e8ddd0", borderRadius: "16px", padding: "28px" }}>
              <h3 style={{ fontSize: "16px", color: "#1a1208", marginTop: 0, marginBottom: "6px", fontWeight: "700" }}>My Recommendations</h3>
              <p style={{ color: "#6b5440", fontSize: "11px", marginBottom: "14px", letterSpacing: "0.05em", fontWeight: "600" }}>YOUR ANALYSIS BASED ON THE DATA ABOVE</p>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Based on the data, here's what I think the key opportunities are..."
                rows={5} style={{ ...inputStyle, resize: "vertical", lineHeight: "1.7" }} />
            </section>
          </main>
        )}

        <footer style={{ textAlign: "center", color: "#c9b99a", fontSize: "11px", marginTop: "40px", letterSpacing: "0.05em" }}>
          Powered by Reddit · Hacker News · DEV.to · Claude — Built as a portfolio project
        </footer>
      </div>
    </div>
  );
}
