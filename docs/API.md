# YouTube Knowledge MCP - API Documentation

## Overview

The YouTube Knowledge MCP server provides five main tools for interacting with YouTube content:

## Tools

### 1. youtube_search

Search for videos on YouTube with advanced filtering options.

**Parameters:**
- `query` (string, required): Search query for YouTube videos
- `maxResults` (number, optional): Maximum number of results (1-50, default: 10)
- `publishedAfter` (string, optional): Filter videos published after this date (ISO 8601)
- `publishedBefore` (string, optional): Filter videos published before this date (ISO 8601)
- `order` (string, optional): Sort order - 'relevance', 'date', 'rating', 'viewCount', 'title' (default: 'relevance')
- `videoDuration` (string, optional): Filter by duration - 'any', 'short', 'medium', 'long' (default: 'any')
- `videoDefinition` (string, optional): Filter by quality - 'any', 'high', 'standard' (default: 'any')
- `regionCode` (string, optional): Region code for localized results (e.g., "US", "GB")

**Example:**
```json
{
  "query": "machine learning tutorial",
  "maxResults": 5,
  "publishedAfter": "2024-01-01T00:00:00Z",
  "order": "relevance",
  "videoDuration": "medium"
}
```

### 2. get_video_details

Get comprehensive information about a specific YouTube video.

**Parameters:**
- `videoId` (string, required): YouTube video ID
- `includeTranscript` (boolean, optional): Whether to include video transcript (default: true)
- `includeComments` (boolean, optional): Whether to include video comments (default: true)
- `maxComments` (number, optional): Maximum number of comments to retrieve (1-100, default: 50)
- `commentsOrder` (string, optional): Sort order for comments - 'relevance', 'time' (default: 'relevance')

**Example:**
```json
{
  "videoId": "dQw4w9WgXcQ",
  "includeTranscript": true,
  "includeComments": true,
  "maxComments": 25
}
```

### 3. get_trending_videos

Discover trending videos in different categories and regions.

**Parameters:**
- `category` (string, optional): Category ID or name (e.g., "Technology", "Education")
- `region` (string, optional): Region code for trending videos (default: "US")
- `maxResults` (number, optional): Maximum number of trending videos to return (1-50, default: 25)

**Example:**
```json
{
  "category": "Technology",
  "region": "US",
  "maxResults": 10
}
```

### 4. analyze_video_content

Get AI-powered analysis and insights from video content.

**Parameters:**
- `videoId` (string, required): YouTube video ID to analyze
- `analysisType` (array, optional): Types of analysis to perform - ['topics', 'sentiment', 'questions', 'summary', 'keywords'] (default: ['summary'])
- `includeComments` (boolean, optional): Include comments in the analysis (default: false)

**Example:**
```json
{
  "videoId": "dQw4w9WgXcQ",
  "analysisType": ["topics", "sentiment", "summary"],
  "includeComments": true
}
```

### 5. search_channels

Find and analyze YouTube channels.

**Parameters:**
- `query` (string, required): Search query for YouTube channels
- `maxResults` (number, optional): Maximum number of channels to return (1-50, default: 10)
- `includeStats` (boolean, optional): Whether to include channel statistics (default: true)
- `order` (string, optional): Sort order - 'relevance', 'date', 'viewCount', 'videoCount' (default: 'relevance')

**Example:**
```json
{
  "query": "AI education channels",
  "maxResults": 5,
  "includeStats": true,
  "order": "relevance"
}
```

## Response Formats

### Video Object
```json
{
  "id": "video_id",
  "title": "Video Title",
  "description": "Video description...",
  "channelId": "channel_id",
  "channelTitle": "Channel Name",
  "publishedAt": "2024-01-01T00:00:00Z",
  "thumbnails": {
    "high": {
      "url": "https://...",
      "width": 480,
      "height": 360
    }
  },
  "duration": "PT10M30S",
  "viewCount": "1000000",
  "likeCount": "50000",
  "commentCount": "1000",
  "tags": ["tag1", "tag2"]
}
```

### Channel Object
```json
{
  "id": "channel_id",
  "title": "Channel Name",
  "description": "Channel description...",
  "subscriberCount": "1000000",
  "videoCount": "500",
  "viewCount": "50000000",
  "publishedAt": "2020-01-01T00:00:00Z",
  "thumbnails": {
    "high": {
      "url": "https://...",
      "width": 800,
      "height": 800
    }
  },
  "country": "US"
}
```

## Quota Management

The server implements intelligent quota management:

- **Daily Limit**: 10,000 quota units (configurable)
- **Reserve Buffer**: 1,000 units reserved for critical operations
- **Smart Caching**: Reduces API calls through intelligent caching
- **Quota Optimization**: Automatically reduces result counts when quota is low

### Quota Costs
- Search operations: 100 units
- Video details: 1 unit
- Channel details: 1 unit
- Comments: 1 unit per request
- Trending videos: 1 unit

## Error Handling

The server provides comprehensive error handling:

- **QuotaExceededError**: When API quota is exhausted
- **YouTubeAPIError**: For general API errors
- **Validation errors**: For invalid input parameters

## Caching Strategy

Intelligent caching with configurable TTL:

- **Transcripts**: 24 hours
- **Video Details**: 1 hour
- **Search Results**: 30 minutes
- **Comments**: 2 hours

## Configuration

Environment variables:
- `YOUTUBE_API_KEY`: Your YouTube Data API v3 key (required)
- `MAX_DAILY_QUOTA`: Daily quota limit (default: 8000)
- `LOG_LEVEL`: Logging level (default: info)
- `CACHE_TTL`: Default cache TTL in seconds (default: 3600)

## Rate Limits

The server respects YouTube API rate limits and implements:
- Automatic retry with exponential backoff
- Request queuing during high load
- Graceful degradation when limits are reached