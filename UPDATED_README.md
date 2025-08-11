# 📺 YouTube Knowledge MCP

Transform YouTube into a queryable knowledge source for AI assistants. This MCP server enables Claude and other AI assistants to search, analyze, and extract insights from YouTube videos beyond simple subtitle extraction.

---

## 🎯 What This Does

- **Search & Discovery**: Find videos by topic, trending content, channel exploration
- **Content Analysis**: Extract transcripts, metadata, key topics, and timestamps
- **Community Intelligence**: Analyze comments, detect questions, sentiment, and viewer intent
- **Knowledge Synthesis**: Turn video content into structured, searchable, and learnable information

---

## ✨ Key Features

### ✅ Phase 1 (Current)
- Video search across all of YouTube
- Transcript extraction (auto-generated + manual subtitles)
- Rich metadata extraction (views, duration, tags, descriptions)
- Comment analysis and summarization
- Trending video discovery
- Smart caching to optimize API quota usage

### 🚀 Phase 2 (In Progress)
- 🔄 **AI-powered content summarization**
- 🔄 **Comment Intent Extraction**: Group and classify viewer comments by intent (questions, praise, criticism, etc.)
- 🔄 **Cross-Video Knowledge Graphs**: Extract and structure knowledge across multiple videos into hierarchical topic maps
- 🔄 **Learning Path Generator**: Build dynamic beginner-to-advanced playlists with summaries and difficulty labels
- 🔄 **Sentiment-Topic Fusion**: Analyze what people feel about different topics (e.g., “positive about quality, negative about price”)
- 🔄 **Explain Like I'm 5 (ELI5) Mode**: Simplify transcripts into beginner-level explanations using LLMs
- 🔄 **AI-Powered Chapter Generator**: Automatically create timestamped chapters with titles from transcripts
- 🔄 **Real-Time Monitoring Tools**: Notify on trending videos matching certain topics or keywords

### 📈 Phase 3 (Planned)
- Personal YouTube channel analytics (OAuth integration)
- Creator tools and competitor analysis
- Advanced sentiment and engagement metrics

---

## 🛠 Available MCP Tools

- `youtube_search({ query, maxResults, publishedAfter, order })`
- `get_video_details({ videoId, includeTranscript, includeComments, maxComments })`
- `get_trending_videos({ category, region, maxResults })`
- `analyze_video_content({ videoId, analysisType })`
- `search_channels({ query, maxResults, includeStats })`
- **(Coming Soon)** `generate_learning_path({ query })`
- **(Coming Soon)** `generate_knowledge_graph({ videoIds })`
- **(Coming Soon)** `analyze_comment_intents({ videoId, maxComments })`
- **(Coming Soon)** `simplify_video_transcript({ videoId })`
- **(Coming Soon)** `generate_video_chapters({ videoId })`

---

## 📊 API Usage & Quotas

- Free YouTube API key gives 10,000 units/day.
- Claude or GPT API usage is metered by token volume — optional and cacheable.
- Smart caching and throttling reduce repeat calls.

---

## 🧠 Claude Integration
Supports Claude Desktop with tools in `claude_desktop_config.json`. All tools can be selectively enabled or disabled per session.

---

## 🧪 Development & Contribution

See `CONTRIBUTING.md` to help with new tools, AI prompt design, caching strategies, or CLI testing.

---

## 📄 License

MIT — Open-source and free to use.

---

## 💡 Coming Soon Landing Page

We are building a companion UI to visualize video graphs, playlist paths, and AI summaries. Stay tuned!