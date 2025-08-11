import { YouTubeTranscript } from '../types.js';
import { Logger } from 'winston';
import axios from 'axios';

/**
 * Utility class for processing YouTube video transcripts
 */
export class TranscriptProcessor {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Extract transcript from a YouTube video
   * Note: This is a simplified implementation. For production use,
   * consider using libraries like youtube-transcript-api
   */
  async extractTranscript(videoId: string): Promise<YouTubeTranscript[]> {
    try {
      // First, try to get the video page to extract caption tracks
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const response = await axios.get(videoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        timeout: 10000
      });

      const htmlContent = response.data;
      
      // Extract caption tracks from the HTML
      const captionTracks = this.extractCaptionTracks(htmlContent);
      
      if (captionTracks.length === 0) {
        this.logger.warn(`No captions found for video ${videoId}`);
        return [];
      }

      // Try to get English captions first, fallback to any available
      const preferredTrack = this.selectPreferredTrack(captionTracks);
      
      if (!preferredTrack) {
        this.logger.warn(`No suitable caption track found for video ${videoId}`);
        return [];
      }

      // Fetch the caption data
      const transcript = await this.fetchCaptionData(preferredTrack.baseUrl);
      
      this.logger.info(`Successfully extracted transcript for video ${videoId}: ${transcript.length} segments`);
      return transcript;
      
    } catch (error) {
      this.logger.error(`Failed to extract transcript for video ${videoId}:`, error);
      return [];
    }
  }

  /**
   * Extract caption track URLs from YouTube page HTML
   */
  private extractCaptionTracks(html: string): any[] {
    try {
      // Look for the player response JSON in the HTML
      const playerResponseMatch = html.match(/"player":\s*({.+?}),"videoDetails"/);
      if (!playerResponseMatch) {
        this.logger.warn('Could not find player response in HTML');
        return [];
      }

      const playerResponse = JSON.parse(playerResponseMatch[1]);
      const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      
      return captionTracks;
      
    } catch (error) {
      this.logger.error('Error parsing caption tracks:', error);
      return [];
    }
  }

  /**
   * Select the preferred caption track (English if available)
   */
  private selectPreferredTrack(tracks: any[]): any | null {
    if (tracks.length === 0) return null;

    // Prefer English tracks
    const englishTrack = tracks.find(track => 
      track.languageCode === 'en' || 
      track.languageCode === 'en-US' ||
      track.languageCode === 'en-GB'
    );
    
    if (englishTrack) return englishTrack;

    // Fallback to auto-generated English
    const autoEnglishTrack = tracks.find(track => 
      track.languageCode?.startsWith('en') && track.kind === 'asr'
    );
    
    if (autoEnglishTrack) return autoEnglishTrack;

    // Fallback to first available track
    return tracks[0];
  }

  /**
   * Fetch caption data from the track URL
   */
  private async fetchCaptionData(baseUrl: string): Promise<YouTubeTranscript[]> {
    try {
      const response = await axios.get(baseUrl, { timeout: 10000 });
      const xmlContent = response.data;
      
      return this.parseTranscriptXML(xmlContent);
      
    } catch (error) {
      this.logger.error('Failed to fetch caption data:', error);
      return [];
    }
  }

  /**
   * Parse YouTube's transcript XML format
   */
  private parseTranscriptXML(xml: string): YouTubeTranscript[] {
    const transcript: YouTubeTranscript[] = [];
    
    try {
      // Simple regex parsing for transcript segments
      // In production, consider using a proper XML parser
      const segments = xml.match(/<text[^>]*start="([^"]*)"[^>]*dur="([^"]*)"[^>]*>([^<]*)<\/text>/g) || [];
      
      for (const segment of segments) {
        const startMatch = segment.match(/start="([^"]*)"/);
        const durationMatch = segment.match(/dur="([^"]*)"/);
        const textMatch = segment.match(/>([^<]*)</);
        
        if (startMatch && durationMatch && textMatch) {
          const start = parseFloat(startMatch[1]);
          const duration = parseFloat(durationMatch[1]);
          const text = this.decodeHTMLEntities(textMatch[1]);
          
          transcript.push({
            text: text.trim(),
            start,
            duration
          });
        }
      }
      
    } catch (error) {
      this.logger.error('Error parsing transcript XML:', error);
    }
    
    return transcript;
  }

  /**
   * Decode HTML entities in transcript text
   */
  private decodeHTMLEntities(text: string): string {
    const entities = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&nbsp;': ' '
    };
    
    return text.replace(/&[#\w]+;/g, (entity) => {
      return entities[entity] || entity;
    });
  }

  /**
   * Process transcript for better readability
   */
  processTranscript(transcript: YouTubeTranscript[]): {
    fullText: string;
    paragraphs: string[];
    summary: {
      totalDuration: number;
      wordCount: number;
      sentenceCount: number;
    };
  } {
    if (transcript.length === 0) {
      return {
        fullText: '',
        paragraphs: [],
        summary: { totalDuration: 0, wordCount: 0, sentenceCount: 0 }
      };
    }

    const fullText = transcript.map(segment => segment.text).join(' ');
    const sentences = this.splitIntoSentences(fullText);
    const paragraphs = this.groupIntoParagraphs(sentences);
    
    const totalDuration = transcript[transcript.length - 1]?.start + transcript[transcript.length - 1]?.duration || 0;
    const wordCount = fullText.split(/\s+/).filter(word => word.length > 0).length;
    const sentenceCount = sentences.length;

    return {
      fullText,
      paragraphs,
      summary: {
        totalDuration,
        wordCount,
        sentenceCount
      }
    };
  }

  /**
   * Search for specific content in transcript
   */
  searchTranscript(transcript: YouTubeTranscript[], query: string): {
    matches: Array<{
      text: string;
      start: number;
      duration: number;
      context: string;
    }>;
    totalMatches: number;
  } {
    const matches = [];
    const queryLower = query.toLowerCase();
    
    for (let i = 0; i < transcript.length; i++) {
      const segment = transcript[i];
      if (segment.text.toLowerCase().includes(queryLower)) {
        // Get context (previous and next segments)
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(transcript.length - 1, i + 2);
        const context = transcript
          .slice(contextStart, contextEnd + 1)
          .map(s => s.text)
          .join(' ');
        
        matches.push({
          text: segment.text,
          start: segment.start,
          duration: segment.duration,
          context
        });
      }
    }
    
    return {
      matches,
      totalMatches: matches.length
    };
  }

  /**
   * Extract key topics from transcript
   */
  extractTopics(transcript: YouTubeTranscript[]): string[] {
    if (transcript.length === 0) return [];
    
    const fullText = transcript.map(segment => segment.text).join(' ').toLowerCase();
    
    // Simple keyword extraction - in production, use more sophisticated NLP
    const words = fullText.split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !this.isStopWord(word));
    
    // Count word frequency
    const wordCount: Record<string, number> = {};
    words.forEach(word => {
      wordCount[word] = (wordCount[word] || 0) + 1;
    });
    
    // Get top 20 most frequent words
    const topics = Object.entries(wordCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([word]) => word);
    
    return topics;
  }

  /**
   * Split text into sentences
   */
  private splitIntoSentences(text: string): string[] {
    return text
      .split(/[.!?]+/)
      .map(sentence => sentence.trim())
      .filter(sentence => sentence.length > 0);
  }

  /**
   * Group sentences into paragraphs
   */
  private groupIntoParagraphs(sentences: string[]): string[] {
    const paragraphs = [];
    const sentencesPerParagraph = 4;
    
    for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
      const paragraph = sentences
        .slice(i, i + sentencesPerParagraph)
        .join('. ') + '.';
      paragraphs.push(paragraph);
    }
    
    return paragraphs;
  }

  /**
   * Check if word is a stop word
   */
  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have',
      'i', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you',
      'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they',
      'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my',
      'one', 'all', 'would', 'there', 'their', 'what', 'so',
      'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go',
      'me', 'when', 'make', 'can', 'like', 'time', 'no', 'just',
      'him', 'know', 'take', 'people', 'into', 'year', 'your',
      'good', 'some', 'could', 'them', 'see', 'other', 'than',
      'then', 'now', 'look', 'only', 'come', 'its', 'over',
      'think', 'also', 'back', 'after', 'use', 'two', 'how',
      'our', 'work', 'first', 'well', 'way', 'even', 'new',
      'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us'
    ]);
    
    return stopWords.has(word.toLowerCase());
  }
}