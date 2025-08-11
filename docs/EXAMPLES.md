# YouTube Knowledge MCP - Usage Examples

## Getting Started

1. **Get your YouTube API Key:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable "YouTube Data API v3"
   - Create API Key under Credentials
   - Copy to your `.env` file

2. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env and add your YOUTUBE_API_KEY
   ```

3. **Build and run:**
   ```bash
   npm install
   npm run build
   npm start
   ```

## Example Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "youtube-knowledge": {
      "command": "node",
      "args": ["/path/to/youtube-knowledge-mcp/build/index.js"],
      "env": {
        "YOUTUBE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## Tool Examples

### 1. Search for Videos

```
Find the top 5 videos about "machine learning basics" from the last month
```

This will use the `youtube_search` tool with parameters:
- query: "machine learning basics"
- maxResults: 5
- publishedAfter: (last month date)

### 2. Analyze Video Content

```
Analyze this video for topics and sentiment: https://youtube.com/watch?v=dQw4w9WgXcQ
```

This will:
1. Extract the video ID from the URL
2. Use `get_video_details` to get transcript and metadata
3. Use `analyze_video_content` to provide insights

### 3. Get Trending Videos

```
Show me the top 10 trending technology videos in the US this week
```

Uses `get_trending_videos` with:
- category: "Technology"
- region: "US"
- maxResults: 10

### 4. Channel Research

```
Find educational YouTube channels about programming with good engagement
```

Uses `search_channels` to find relevant channels and provides analytics.

### 5. Video Summary

```
Give me a detailed summary of this tutorial: https://youtube.com/watch?v=example123
```

Combines multiple tools to provide comprehensive analysis.

## Advanced Examples

### Research Query
```
"Research the latest AI developments by finding recent videos from top AI channels, analyze their content for key topics, and summarize the main trends."
```

This complex query would:
1. Search for AI-related channels
2. Get their recent videos
3. Analyze video content for topics
4. Synthesize findings into trends

### Educational Content Discovery
```
"Find beginner-friendly Python tutorials from the last 6 months, analyze them for difficulty level, and recommend the best ones based on engagement metrics."
```

### Competitive Analysis
```
"Analyze the top 5 channels in the 'tech review' space, compare their content strategies, upload frequency, and audience engagement patterns."
```

## Common Use Cases

### Content Creator Research
- Find trending topics in your niche
- Analyze competitor content strategies
- Research audience engagement patterns
- Discover content gaps and opportunities

### Educational Research
- Find high-quality educational content
- Analyze learning paths and curricula
- Compare different teaching approaches
- Track educational trends over time

### Market Intelligence
- Monitor industry discussions and sentiment
- Track product mentions and reviews
- Analyze community feedback and questions
- Identify emerging topics and trends

### Academic Research
- Gather video content for analysis
- Study social media discourse patterns
- Analyze public opinion on topics
- Extract structured data from video content

## Tips for Best Results

### Quota Management
- Use specific search terms to get better results with fewer API calls
- Cache results are automatically used when available
- The system prioritizes recent content when quota is limited

### Search Optimization
- Use specific keywords rather than broad terms
- Combine multiple filters (date, duration, quality) for precision
- Use channel-specific searches when researching competitors

### Content Analysis
- Include transcript analysis for deeper insights
- Use comment analysis for audience sentiment
- Combine multiple analysis types for comprehensive understanding

### Performance Tips
- Batch related queries together
- Use the built-in caching for frequently accessed content
- Monitor quota usage through the analytics features

## Error Handling

The system gracefully handles:
- API quota exceeded (uses cached data when possible)
- Network timeouts (automatic retry)
- Missing content (provides alternatives)
- Rate limiting (queues requests)

## Monitoring and Analytics

Built-in features include:
- Real-time quota usage tracking
- Cache hit/miss statistics
- Error rate monitoring
- Performance metrics

Check logs for detailed information about operations and system health.