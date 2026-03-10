import http from "http";

const PORT = 3001;

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/analyze") {
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
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
