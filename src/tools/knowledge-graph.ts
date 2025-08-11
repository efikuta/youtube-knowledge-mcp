import { Logger } from 'winston';
import { YouTubeClient } from '../youtube-client.js';
import { CacheManager } from '../utils/cache.js';
import { RobustLLMService } from '../utils/llm-service.js';
import { TranscriptProcessor } from '../utils/transcript.js';
import { 
  GenerateKnowledgeGraphParams, 
  GenerateKnowledgeGraphSchema,
  KnowledgeGraph,
  VideoDetailsResult
} from '../types.js';

interface ConceptExtraction {
  concepts: Array<{
    name: string;
    type: 'concept' | 'person' | 'tool' | 'process' | 'theory';
    importance: number;
    context: string;
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
    confidence: number;
    evidence: string;
  }>;
}

export class KnowledgeGraphGenerator {
  constructor(
    private youtubeClient: YouTubeClient,
    private cache: CacheManager,
    private llmService: RobustLLMService,
    private transcriptProcessor: TranscriptProcessor,
    private logger: Logger
  ) {}

  async execute(args: unknown): Promise<KnowledgeGraph> {
    const params = GenerateKnowledgeGraphSchema.parse(args);
    
    this.logger.info(`Generating knowledge graph for ${params.videoIds.length} videos`);

    // Generate cache key
    const cacheKey = `knowledge_graph:${params.videoIds.sort().join(',')}:${params.graphDepth}`;

    // Check cache first
    const cached = await this.cache.get<KnowledgeGraph>(cacheKey);
    if (cached) {
      this.logger.info(`Returning cached knowledge graph for videos`);
      return cached;
    }

    try {
      // Step 1: Gather video data
      const videoData = await this.gatherVideoData(params);

      // Step 2: Extract concepts from each video
      const conceptExtractions = await this.extractConceptsFromVideos(videoData, params);

      // Step 3: Merge and deduplicate concepts
      const mergedConcepts = this.mergeConceptExtractions(conceptExtractions);

      // Step 4: Build knowledge graph structure
      const knowledgeGraph = await this.buildKnowledgeGraph(mergedConcepts, videoData, params);

      // Step 5: Enhance with clustering and analysis
      const enhancedGraph = await this.enhanceKnowledgeGraph(knowledgeGraph);

      // Cache the result
      await this.cache.set(cacheKey, enhancedGraph, 7200); // 2 hours cache
      
      this.logger.info(`Knowledge graph generated: ${enhancedGraph.nodes.length} nodes, ${enhancedGraph.edges.length} edges`);
      
      return enhancedGraph;

    } catch (error) {
      this.logger.error(`Failed to generate knowledge graph:`, error);
      throw error;
    }
  }

  /**
   * Gather comprehensive data for all videos
   */
  private async gatherVideoData(params: GenerateKnowledgeGraphParams): Promise<VideoDetailsResult[]> {
    const videoDataPromises = params.videoIds.map(async (videoId) => {
      try {
        return await this.youtubeClient.getVideoDetails({
          videoId,
          includeTranscript: params.includeTranscripts,
          includeComments: false // Focus on content, not comments for knowledge graphs
        });
      } catch (error) {
        this.logger.warn(`Failed to get details for video ${videoId}:`, error);
        return null;
      }
    });

    const results = await Promise.all(videoDataPromises);
    return results.filter((result): result is VideoDetailsResult => result !== null);
  }

  /**
   * Extract concepts from each video using LLM analysis
   */
  private async extractConceptsFromVideos(
    videoData: VideoDetailsResult[],
    params: GenerateKnowledgeGraphParams
  ): Promise<ConceptExtraction[]> {
    const extractions: ConceptExtraction[] = [];

    for (let i = 0; i < videoData.length; i++) {
      const video = videoData[i];
      
      try {
        this.logger.info(`Extracting concepts from video ${i + 1}/${videoData.length}: ${video.video.title}`);
        
        const extraction = await this.extractConceptsFromSingleVideo(video, params);
        extractions.push(extraction);

        // Rate limiting delay
        if (i < videoData.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        this.logger.warn(`Failed to extract concepts from video ${video.video.id}:`, error);
        
        // Add basic extraction as fallback
        extractions.push(this.createBasicExtraction(video));
      }
    }

    return extractions;
  }

  /**
   * Extract concepts from a single video
   */
  private async extractConceptsFromSingleVideo(
    video: VideoDetailsResult,
    params: GenerateKnowledgeGraphParams
  ): Promise<ConceptExtraction> {
    const prompt = this.buildConceptExtractionPrompt(video, params);

    const response = await this.llmService.generateWithFallback({
      prompt,
      model: params.graphDepth === 'deep' ? 'gpt-4o' : 'gpt-4o-mini',
      maxTokens: params.graphDepth === 'deep' ? 2000 : 1200,
      temperature: 0.1,
      responseFormat: 'json'
    });

    try {
      const extraction = JSON.parse(response.content);
      return this.validateAndNormalizeExtraction(extraction, video.video.id);
    } catch (error) {
      this.logger.warn(`Failed to parse concept extraction for ${video.video.id}:`, error);
      return this.createBasicExtraction(video);
    }
  }

  /**
   * Build concept extraction prompt
   */
  private buildConceptExtractionPrompt(
    video: VideoDetailsResult,
    params: GenerateKnowledgeGraphParams
  ): string {
    const contentToAnalyze = this.prepareContentForAnalysis(video, params);
    const depthInstructions = this.getDepthInstructions(params.graphDepth);
    const focusTopicsInstruction = params.focusTopics && params.focusTopics.length > 0
      ? `\nFocus especially on these topics: ${params.focusTopics.join(', ')}`
      : '';

    return `Extract knowledge concepts and relationships from this YouTube video content for building a knowledge graph.

Video: "${video.video.title}"
Category: ${video.video.categoryId}

Content to analyze:
${contentToAnalyze}

${depthInstructions}${focusTopicsInstruction}

Instructions:
1. Identify key concepts, theories, people, tools, and processes
2. Determine relationships between concepts
3. Assess importance and confidence levels
4. Provide evidence for relationships

Respond with JSON:
{
  "concepts": [
    {
      "name": "concept name",
      "type": "concept|person|tool|process|theory",
      "importance": 0.9,
      "context": "brief explanation of how it's used in the video"
    }
  ],
  "relationships": [
    {
      "from": "concept1",
      "to": "concept2", 
      "type": "depends_on|part_of|enables|contradicts|similar_to|caused_by",
      "confidence": 0.8,
      "evidence": "specific quote or context from content"
    }
  ]
}`;
  }

  /**
   * Prepare content for analysis based on available data
   */
  private prepareContentForAnalysis(
    video: VideoDetailsResult,
    params: GenerateKnowledgeGraphParams
  ): string {
    let content = `Title: ${video.video.title}\n`;
    content += `Description: ${video.video.description.slice(0, 500)}\n`;

    if (video.video.tags && video.video.tags.length > 0) {
      content += `Tags: ${video.video.tags.join(', ')}\n`;
    }

    if (params.includeTranscripts && video.transcript && video.transcript.length > 0) {
      const transcriptText = video.transcript
        .map(t => t.text)
        .join(' ')
        .slice(0, 8000); // Limit length for token management
      content += `\nTranscript: ${transcriptText}`;
    }

    return content;
  }

  /**
   * Get analysis depth instructions
   */
  private getDepthInstructions(depth: 'shallow' | 'medium' | 'deep'): string {
    switch (depth) {
      case 'shallow':
        return 'Extract 5-10 main concepts and their direct relationships. Focus on the most obvious and important connections.';
      case 'deep':
        return 'Extract 15-25 concepts including subtle nuances, implicit relationships, and deeper connections. Include theoretical frameworks and methodological approaches.';
      default:
        return 'Extract 10-15 key concepts and relationships. Balance breadth with depth of analysis.';
    }
  }

  /**
   * Validate and normalize concept extraction
   */
  private validateAndNormalizeExtraction(
    extraction: any,
    videoId: string
  ): ConceptExtraction {
    const concepts = (extraction.concepts || [])
      .filter((c: any) => c.name && c.type)
      .map((c: any) => ({
        name: c.name.trim(),
        type: ['concept', 'person', 'tool', 'process', 'theory'].includes(c.type) ? c.type : 'concept',
        importance: Math.max(0, Math.min(1, c.importance || 0.5)),
        context: c.context || ''
      }));

    const relationships = (extraction.relationships || [])
      .filter((r: any) => r.from && r.to && r.type)
      .map((r: any) => ({
        from: r.from.trim(),
        to: r.to.trim(),
        type: r.type,
        confidence: Math.max(0, Math.min(1, r.confidence || 0.5)),
        evidence: r.evidence || ''
      }))
      // Only keep relationships between extracted concepts
      .filter((r: any) => 
        concepts.some((c: any) => c.name === r.from) &&
        concepts.some((c: any) => c.name === r.to)
      );

    return { concepts, relationships };
  }

  /**
   * Create basic extraction fallback
   */
  private createBasicExtraction(video: VideoDetailsResult): ConceptExtraction {
    const titleWords = video.video.title
      .split(/\s+/)
      .filter(word => word.length > 3)
      .slice(0, 5);

    const concepts = titleWords.map(word => ({
      name: word,
      type: 'concept' as const,
      importance: 0.5,
      context: `Mentioned in video title: ${video.video.title}`
    }));

    const relationships = concepts.length > 1 ? [{
      from: concepts[0].name,
      to: concepts[1].name,
      type: 'related_to',
      confidence: 0.3,
      evidence: 'Co-occurrence in video title'
    }] : [];

    return { concepts, relationships };
  }

  /**
   * Merge concept extractions from multiple videos
   */
  private mergeConceptExtractions(extractions: ConceptExtraction[]): ConceptExtraction {
    const allConcepts: Map<string, any> = new Map();
    const allRelationships: Array<any> = [];

    // Merge concepts (combine duplicate names)
    extractions.forEach(extraction => {
      extraction.concepts.forEach(concept => {
        const key = concept.name.toLowerCase();
        if (allConcepts.has(key)) {
          const existing = allConcepts.get(key);
          existing.importance = Math.max(existing.importance, concept.importance);
          existing.context += '; ' + concept.context;
        } else {
          allConcepts.set(key, { ...concept });
        }
      });

      // Add relationships
      allRelationships.push(...extraction.relationships);
    });

    // Deduplicate relationships
    const uniqueRelationships = this.deduplicateRelationships(allRelationships);

    return {
      concepts: Array.from(allConcepts.values()),
      relationships: uniqueRelationships
    };
  }

  /**
   * Deduplicate relationships
   */
  private deduplicateRelationships(relationships: Array<any>): Array<any> {
    const seen = new Set<string>();
    const unique: Array<any> = [];

    relationships.forEach(rel => {
      const key1 = `${rel.from.toLowerCase()}-${rel.to.toLowerCase()}-${rel.type}`;
      const key2 = `${rel.to.toLowerCase()}-${rel.from.toLowerCase()}-${rel.type}`;
      
      if (!seen.has(key1) && !seen.has(key2)) {
        seen.add(key1);
        unique.push(rel);
      } else {
        // Merge confidence scores for duplicates
        const existingIndex = unique.findIndex(u => 
          (u.from.toLowerCase() === rel.from.toLowerCase() && u.to.toLowerCase() === rel.to.toLowerCase()) ||
          (u.from.toLowerCase() === rel.to.toLowerCase() && u.to.toLowerCase() === rel.from.toLowerCase())
        );
        
        if (existingIndex >= 0) {
          unique[existingIndex].confidence = Math.max(unique[existingIndex].confidence, rel.confidence);
          unique[existingIndex].evidence += '; ' + rel.evidence;
        }
      }
    });

    return unique;
  }

  /**
   * Build knowledge graph structure
   */
  private async buildKnowledgeGraph(
    mergedConcepts: ConceptExtraction,
    videoData: VideoDetailsResult[],
    params: GenerateKnowledgeGraphParams
  ): Promise<KnowledgeGraph> {
    // Create nodes
    const nodes = mergedConcepts.concepts.map((concept, index) => ({
      id: `concept_${index}`,
      label: concept.name,
      type: concept.type,
      weight: concept.importance,
      properties: {
        context: concept.context,
        mentionedInVideos: this.findVideoMentions(concept.name, videoData)
      }
    }));

    // Add video nodes
    const videoNodes = videoData.map(video => ({
      id: video.video.id,
      label: video.video.title,
      type: 'video' as const,
      weight: 0.8,
      properties: {
        channelTitle: video.video.channelTitle,
        viewCount: video.video.viewCount,
        publishedAt: video.video.publishedAt,
        duration: video.video.duration
      }
    }));

    const allNodes = [...nodes, ...videoNodes];

    // Create edges
    const conceptEdges = mergedConcepts.relationships.map((rel, index) => {
      const sourceNode = nodes.find(n => n.label.toLowerCase() === rel.from.toLowerCase());
      const targetNode = nodes.find(n => n.label.toLowerCase() === rel.to.toLowerCase());
      
      return {
        source: sourceNode?.id || rel.from,
        target: targetNode?.id || rel.to,
        relationship: rel.type,
        weight: rel.confidence,
        evidence: [rel.evidence]
      };
    }).filter(edge => edge.source && edge.target);

    // Add video-concept edges
    const videoConceptEdges: Array<any> = [];
    videoData.forEach(video => {
      nodes.forEach(conceptNode => {
        if (conceptNode.properties.mentionedInVideos.includes(video.video.id)) {
          videoConceptEdges.push({
            source: video.video.id,
            target: conceptNode.id,
            relationship: 'mentions',
            weight: 0.7,
            evidence: [`Mentioned in video: ${video.video.title}`]
          });
        }
      });
    });

    const allEdges = [...conceptEdges, ...videoConceptEdges];

    return {
      nodes: allNodes,
      edges: allEdges,
      clusters: [], // Will be filled by clustering
      metadata: {
        totalConcepts: nodes.length,
        connectionDensity: allEdges.length / (allNodes.length * (allNodes.length - 1)),
        primaryTopics: this.extractPrimaryTopics(nodes),
        confidenceScore: this.calculateOverallConfidence(allEdges)
      }
    };
  }

  /**
   * Find which videos mention a specific concept
   */
  private findVideoMentions(conceptName: string, videoData: VideoDetailsResult[]): string[] {
    const mentions: string[] = [];
    const lowerConceptName = conceptName.toLowerCase();

    videoData.forEach(video => {
      const searchContent = [
        video.video.title,
        video.video.description,
        ...(video.video.tags || []),
        ...(video.transcript?.map(t => t.text) || [])
      ].join(' ').toLowerCase();

      if (searchContent.includes(lowerConceptName)) {
        mentions.push(video.video.id);
      }
    });

    return mentions;
  }

  /**
   * Extract primary topics from nodes
   */
  private extractPrimaryTopics(nodes: Array<any>): string[] {
    return nodes
      .filter(node => node.type === 'concept' && node.weight > 0.7)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map(node => node.label);
  }

  /**
   * Calculate overall confidence score
   */
  private calculateOverallConfidence(edges: Array<any>): number {
    if (edges.length === 0) return 0;
    
    const avgConfidence = edges.reduce((sum, edge) => sum + edge.weight, 0) / edges.length;
    return Math.round(avgConfidence * 100) / 100;
  }

  /**
   * Enhance knowledge graph with clustering and additional analysis
   */
  private async enhanceKnowledgeGraph(graph: KnowledgeGraph): Promise<KnowledgeGraph> {
    // Perform concept clustering
    const clusters = await this.performClustering(graph);
    
    return {
      ...graph,
      clusters
    };
  }

  /**
   * Perform concept clustering using simple similarity-based approach
   */
  private async performClustering(graph: KnowledgeGraph): Promise<KnowledgeGraph['clusters']> {
    const conceptNodes = graph.nodes.filter(node => node.type !== 'video');
    
    if (conceptNodes.length < 3) {
      return [{
        id: 'cluster_1',
        name: 'Main Concepts',
        nodes: conceptNodes.map(n => n.id),
        description: 'Primary concepts from the analyzed content'
      }];
    }

    try {
      // Use LLM to perform intelligent clustering
      const clusteringPrompt = this.buildClusteringPrompt(conceptNodes, graph.edges);
      
      const response = await this.llmService.generateWithFallback({
        prompt: clusteringPrompt,
        model: 'gpt-4o-mini',
        maxTokens: 1000,
        temperature: 0.1,
        responseFormat: 'json'
      });

      const clusterData = JSON.parse(response.content);
      return this.processClusteringResponse(clusterData, conceptNodes);

    } catch (error) {
      this.logger.warn('LLM clustering failed, using rule-based clustering:', error);
      return this.performRuleBasedClustering(conceptNodes, graph.edges);
    }
  }

  /**
   * Build clustering prompt for LLM
   */
  private buildClusteringPrompt(nodes: Array<any>, edges: Array<any>): string {
    const nodeList = nodes.map(node => 
      `- ${node.label} (${node.type}, importance: ${node.weight})`
    ).join('\n');

    const relationshipList = edges
      .filter(edge => nodes.some(n => n.id === edge.source) && nodes.some(n => n.id === edge.target))
      .slice(0, 20) // Limit for prompt size
      .map(edge => {
        const sourceLabel = nodes.find(n => n.id === edge.source)?.label || edge.source;
        const targetLabel = nodes.find(n => n.id === edge.target)?.label || edge.target;
        return `- ${sourceLabel} ${edge.relationship} ${targetLabel}`;
      }).join('\n');

    return `Group these concepts into 3-5 logical clusters based on their relationships and semantic similarity.

Concepts:
${nodeList}

Relationships:
${relationshipList}

Create clusters that represent coherent topic areas or knowledge domains. Each cluster should have a meaningful name and description.

Respond with JSON:
{
  "clusters": [
    {
      "name": "Cluster Name",
      "description": "What this cluster represents",
      "concepts": ["concept1", "concept2"]
    }
  ]
}`;
  }

  /**
   * Process LLM clustering response
   */
  private processClusteringResponse(
    clusterData: any, 
    conceptNodes: Array<any>
  ): KnowledgeGraph['clusters'] {
    if (!clusterData.clusters || !Array.isArray(clusterData.clusters)) {
      return this.performRuleBasedClustering(conceptNodes, []);
    }

    return clusterData.clusters.map((cluster: any, index: number) => ({
      id: `cluster_${index + 1}`,
      name: cluster.name || `Cluster ${index + 1}`,
      nodes: (cluster.concepts || [])
        .map((conceptName: string) => 
          conceptNodes.find(node => 
            node.label.toLowerCase() === conceptName.toLowerCase()
          )?.id
        )
        .filter(Boolean),
      description: cluster.description || 'Related concepts grouped together'
    }));
  }

  /**
   * Rule-based clustering fallback
   */
  private performRuleBasedClustering(
    conceptNodes: Array<any>, 
    edges: Array<any>
  ): KnowledgeGraph['clusters'] {
    // Simple clustering by concept type
    const typeGroups: Record<string, string[]> = {};
    
    conceptNodes.forEach(node => {
      if (!typeGroups[node.type]) {
        typeGroups[node.type] = [];
      }
      typeGroups[node.type].push(node.id);
    });

    return Object.entries(typeGroups).map(([type, nodeIds], index) => ({
      id: `cluster_${index + 1}`,
      name: `${type.charAt(0).toUpperCase() + type.slice(1)}s`,
      nodes: nodeIds,
      description: `Concepts of type: ${type}`
    }));
  }
}