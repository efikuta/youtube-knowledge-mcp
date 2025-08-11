## YouTube Knowledge MCP

Production-ready Model Context Protocol (MCP) server that turns YouTube into a queryable knowledge source. Search, fetch details, analyze transcripts/comments, and power AI workflows with optional LLMs. Built for Claude Desktop and other MCP clients.

### Why this is special

- **Fast + quota-aware** YouTube API access with caching
- **Batteries-included tools** for search, details, trending, channels
- **Optional AI superpowers** (OpenAI/Anthropic) for summaries, topics, chapters, learning paths, comment intents, and knowledge graphs
- **Zero noise**: minimal config, clear logs, safe defaults

### Requirements

- Node.js 18+
- YouTube Data API v3 key
- Optional: OpenAI and/or Anthropic API keys for AI tools

### Install

```bash
npm install
```

### Configure environment

Create `.env` (or set variables in your MCP client config). You can start from the example:

```bash
cp env.example .env
```

Then set values in `.env`:

```env
# Required
YOUTUBE_API_KEY=your_youtube_api_key

# Optional AI providers (enables AI tools: analyze_video_content, generate_learning_path, analyze_comment_intents, simplify_video_transcript, generate_video_chapters, generate_knowledge_graph)
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key

# Optional tuning
LOG_LEVEL=info
MAX_DAILY_QUOTA=8000
REDIS_URL= # e.g. redis://localhost:6379
REDIS_HOST=
REDIS_PORT=
REDIS_PASSWORD=
```

An `env.example` with placeholders is provided. Do not commit your `.env`.

### Build and run

```bash
# Development (watch)
npm run dev

# Production
npm run build
npm start
```

### Connect to Claude Desktop (example)

Add to your Claude Desktop configuration with absolute paths:

```json
{
  "mcpServers": {
    "youtube-knowledge": {
      "command": "node",
      "args": ["/absolute/path/to/youtube-knowledge-mcp/build/index.js"],
      "env": {
        "YOUTUBE_API_KEY": "your_youtube_api_key",
        "OPENAI_API_KEY": "optional_openai",
        "ANTHROPIC_API_KEY": "optional_anthropic",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config.

### Available tools

- `youtube_search` — Search videos with filters
- `get_video_details` — Video metadata, transcript (best-effort), comments
- `get_trending_videos` — Most popular by region/category
- `search_channels` — Channel search with optional stats
- `analyze_video_content` — AI topics/sentiment/questions/summary/keywords
- `generate_learning_path` — AI learning path for a topic
- `analyze_comment_intents` — Classify viewer intents
- `simplify_video_transcript` — ELI5-style simplification
- `generate_video_chapters` — AI chapters with timestamps
- `generate_knowledge_graph` — Cross-video concept graph

Note: AI tools are available only if an AI provider key is configured.

### Quotas and safety

- Enforces daily quota (default 8000 units) and cost-aware AI usage
- Logs to stderr (does not break MCP stdio)
- Caching reduces API and token spend; optional Redis supported

### Troubleshooting

- Missing key: ensure `YOUTUBE_API_KEY` is set
- Quota exceeded: lower usage, enable caching, or raise `MAX_DAILY_QUOTA`
- Claude cannot connect: verify absolute path to `build/index.js` and restart

### License

MIT

Let’s build something crazy with MCP.
