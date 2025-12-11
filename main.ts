// infiniax-deno-proxy: OpenAI-compatible proxy for infiniax.ai
// Single-file Deno implementation with zero external dependencies

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(Deno.env.get("PORT")) || 3000;
const COOKIE = Deno.env.get("INFINIAX_COOKIE");
const UPSTREAM_URL = "https://infiniax.ai/api/chat/stream";

// ============================================================================
// Startup Validation
// ============================================================================

// Validate cookie - will show error on first request if not set
// Note: Deno Deploy doesn't support Deno.exit(), so we handle this gracefully

// ============================================================================
// Type Definitions
// ============================================================================

interface OpenAIRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  web_search?: boolean; // Custom field to enable web search
}

interface InfiniaxRequest {
  modelId: string;
  messages: Array<{ role: string; content: string }>;
  webSearchEnabled?: boolean;
}

interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

// ============================================================================
// Request Transformation
// ============================================================================

/**
 * Transforms an OpenAI chat completion request to infiniax API format.
 * - model → modelId (direct passthrough)
 * - messages → messages (direct passthrough)
 * - web_search → webSearchEnabled (optional)
 */
export function transformRequest(openaiReq: OpenAIRequest): InfiniaxRequest {
  const result: InfiniaxRequest = {
    modelId: openaiReq.model,
    messages: openaiReq.messages,
  };
  
  // Enable web search if requested
  if (openaiReq.web_search) {
    result.webSearchEnabled = true;
  }
  
  return result;
}

// ============================================================================
// Response Transformation
// ============================================================================

/**
 * Generates a unique ID for OpenAI response format.
 */
function generateId(): string {
  return "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/**
 * Transforms an infiniax stream chunk to OpenAI SSE delta format.
 * Input: Raw text content from infiniax stream
 * Output: SSE formatted string "data: {json}\n\n"
 * 
 * Requirements: 4.1, 4.2
 */
export function transformStreamChunk(
  content: string,
  model: string,
  responseId: string,
  created: number,
  isFirst: boolean = false
): string {
  const chunk: OpenAIStreamChunk = {
    id: responseId,
    object: "chat.completion.chunk",
    created: created,
    model: model,
    choices: [
      {
        index: 0,
        delta: isFirst ? { role: "assistant", content: content } : { content: content },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Creates the final SSE chunk indicating stream completion.
 */
export function createStreamEndChunk(
  model: string,
  responseId: string,
  created: number
): string {
  const chunk: OpenAIStreamChunk = {
    id: responseId,
    object: "chat.completion.chunk",
    created: created,
    model: model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/**
 * Transforms a complete infiniax response to OpenAI chat completion format.
 * Used for non-streaming responses.
 * 
 * Requirements: 5.1, 5.2
 */
export function transformResponse(
  content: string,
  model: string
): OpenAIResponse {
  return {
    id: generateId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content,
        },
        finish_reason: "stop",
      },
    ],
  };
}

// ============================================================================
// Error Response Helpers
// ============================================================================

/**
 * Creates a standardized error response in OpenAI error format.
 * Requirements: 3.4, 7.1, 7.2, 7.3
 */
function errorResponse(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: { message } }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Maps upstream HTTP status codes to appropriate proxy responses.
 * Requirements: 7.1, 7.3
 */
function handleUpstreamError(status: number): Response {
  // Authentication failures (401/403 from upstream)
  if (status === 401 || status === 403) {
    return errorResponse("Authentication failed", 401);
  }
  // All other upstream errors are treated as 502 Bad Gateway
  return errorResponse("Upstream error", 502);
}

// ============================================================================
// Chat Completions Handler
// ============================================================================

/**
 * Handles POST /v1/chat/completions requests.
 * - Parses request body
 * - Transforms to infiniax format
 * - Sends request to infiniax API with Cookie
 * - Handles streaming/non-streaming responses
 * 
 * Requirements: 3.1, 3.4, 4.1, 4.3, 5.1, 7.1, 7.2, 7.3
 */
async function handleChatCompletions(req: Request): Promise<Response> {
  try {
    // Parse request body (Requirements: 3.4 - Invalid JSON → 400)
    let openaiReq: OpenAIRequest;
    try {
      openaiReq = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    // Validate required fields
    if (!openaiReq.model || !openaiReq.messages) {
      return errorResponse("Missing required fields: model and messages", 400);
    }

    // Transform request to infiniax format
    const infiniaxReq = transformRequest(openaiReq);
    const isStreaming = openaiReq.stream === true;

    // Send request to infiniax API
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": COOKIE || "",
        },
        body: JSON.stringify(infiniaxReq),
      });
    } catch (error) {
      // Network errors, DNS failures, etc. → 502 (Requirements: 7.1)
      console.error("Upstream request failed:", error);
      return errorResponse("Upstream error", 502);
    }

    // Handle upstream errors (Requirements: 7.1, 7.3)
    if (!upstreamResponse.ok) {
      return handleUpstreamError(upstreamResponse.status);
    }

    // Handle streaming response
    if (isStreaming) {
      return handleStreamingResponse(upstreamResponse, openaiReq.model);
    }

    // Handle non-streaming response
    return handleNonStreamingResponse(upstreamResponse, openaiReq.model);
  } catch (error) {
    // Catch-all for unexpected errors (Requirements: 7.2 - Unknown errors → 500)
    console.error("Unexpected error in handleChatCompletions:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * Processes streaming response from infiniax and converts to OpenAI SSE format.
 * infiniax format: data: {"chunk":"text"}\n\n
 * OpenAI format: data: {"id":...,"choices":[{"delta":{"content":"text"}}]}\n\n
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */
function handleStreamingResponse(
  upstreamResponse: Response,
  model: string
): Response {
  const responseId = generateId();
  const created = Math.floor(Date.now() / 1000);
  let isFirst = true;
  let buffer = '';

  const body = upstreamResponse.body;
  if (!body) {
    return errorResponse("No response body from upstream", 502);
  }

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        buffer += new TextDecoder().decode(chunk);
        
        // Process complete SSE messages (ending with \n\n)
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || ''; // Keep incomplete message in buffer
        
        for (const msg of messages) {
          if (msg.startsWith('data: ')) {
            try {
              const data = JSON.parse(msg.slice(6));
              if (data.chunk) {
                const sseChunk = transformStreamChunk(data.chunk, model, responseId, created, isFirst);
                isFirst = false;
                controller.enqueue(new TextEncoder().encode(sseChunk));
              }
              // Skip done messages, we'll send our own [DONE]
            } catch {
              // Skip invalid JSON
            }
          }
        }
      } catch (error) {
        // Log error but continue processing (Requirements: 4.4 - graceful handling)
        console.error("Error processing stream chunk:", error);
      }
    },
    flush(controller) {
      // Process any remaining buffer
      if (buffer.startsWith('data: ')) {
        try {
          const data = JSON.parse(buffer.slice(6));
          if (data.chunk) {
            const sseChunk = transformStreamChunk(data.chunk, model, responseId, created, isFirst);
            controller.enqueue(new TextEncoder().encode(sseChunk));
          }
        } catch {
          // Skip invalid JSON
        }
      }
      // Send stream end marker
      const endChunk = createStreamEndChunk(model, responseId, created);
      controller.enqueue(new TextEncoder().encode(endChunk));
    },
  });

  // Handle upstream connection failures during streaming (Requirements: 4.4)
  const transformedBody = body.pipeThrough(transformStream);

  return new Response(transformedBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * Parses infiniax SSE response and extracts content chunks.
 * infiniax format: data: {"chunk":"text"}\n\ndata: {"done":true}\n\n
 */
function parseInfiniaxSSE(sseText: string): string {
  const lines = sseText.split('\n');
  let content = '';
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.chunk) {
          content += data.chunk;
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  }
  
  return content;
}

/**
 * Processes non-streaming response from infiniax and converts to OpenAI format.
 * Requirements: 5.1, 5.2, 5.3
 */
async function handleNonStreamingResponse(
  upstreamResponse: Response,
  model: string
): Promise<Response> {
  try {
    // Collect all chunks into complete content
    const rawContent = await upstreamResponse.text();
    
    // Parse infiniax SSE format to extract actual content
    const content = parseInfiniaxSSE(rawContent);
    
    // Transform to OpenAI response format
    const openaiResponse = transformResponse(content, model);

    return new Response(JSON.stringify(openaiResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Handle errors during response processing (Requirements: 5.3)
    console.error("Error processing non-streaming response:", error);
    return errorResponse("Upstream error", 502);
  }
}

// ============================================================================
// Models Handler
// ============================================================================

/**
 * Official model list from infiniax.ai
 * Source: https://infiniax.ai (extracted from frontend)
 */
const INFINIAX_MODELS = [
  // Featured FREE models
  { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B", provider: "Meta", description: "FREE - High quality open-source" },
  { id: "amazon/nova-2-lite-v1:free", name: "Nova 2 Lite", provider: "Amazon", description: "FREE - Fast and efficient" },
  { id: "arcee-ai/trinity-mini:free", name: "Trinity Mini", provider: "Arcee AI", description: "FREE - Compact reasoning model" },
  { id: "deepseek/deepseek-v3.2-exp", name: "DeepSeek 3.2 Exp", provider: "DeepSeek", description: "FREE - Next-gen experimental" },
  { id: "mistralai/ministral-14b-2512", name: "Mistral 14B", provider: "Mistral AI", description: "FREE - Fast European AI" },
  { id: "z-ai/glm-4.6v", name: "GLM 4.6v", provider: "Z.ai", description: "FREE - Advanced reasoning" },
  // Premium models
  { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", provider: "Anthropic", description: "PREMIUM - Advanced Coding & Writing" },
  { id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro", provider: "Google", description: "PREMIUM - Peak Intelligence" },
  { id: "openai/gpt-5-pro", name: "GPT-5 Pro", provider: "OpenAI", description: "PREMIUM - Most Expensive, Best output" },
  // OpenAI models
  { id: "openai/gpt-5.1", name: "GPT-5.1", provider: "OpenAI", description: "FREE - Enhanced GPT-5 model" },
  { id: "openai/gpt-5.1-chat", name: "GPT-5.1 Chat", provider: "OpenAI", description: "FREE - Optimized for conversations" },
  { id: "openai/gpt-5.1-codex-max", name: "GPT-5.1 Codex Max", provider: "OpenAI", description: "FREE - Advanced reasoning for large tasks" },
  { id: "openai/gpt-5", name: "GPT-5", provider: "OpenAI", description: "FREE - Next-generation flagship model" },
  { id: "openai/gpt-5-mini", name: "GPT-5 Mini", provider: "OpenAI", description: "FREE - Fast and efficient GPT-5" },
  { id: "openai/gpt-5-nano", name: "GPT-5 Nano", provider: "OpenAI", description: "FREE - Ultra-lightweight GPT-5" },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "OpenAI", description: "FREE - Multimodal GPT-4 optimized" },
  { id: "openai/gpt-4-turbo", name: "GPT-4 Turbo", provider: "OpenAI", description: "FREE - Previous generation flagship" },
  { id: "openai/gpt-3.5-turbo", name: "GPT-3.5 Turbo", provider: "OpenAI", description: "FREE - Fast and economical" },
  // Anthropic models
  { id: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1", provider: "Anthropic", description: "FREE - Most capable Claude model" },
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "Anthropic", description: "FREE - Balanced performance and speed" },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", provider: "Anthropic", description: "FREE - Lightning-fast responses" },
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "Anthropic", description: "FREE - Advanced reasoning and coding" },
  { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet", provider: "Anthropic", description: "FREE - Enhanced Claude 3 generation" },
  { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku", provider: "Anthropic", description: "FREE - Fast and efficient Claude" },
  { id: "anthropic/claude-3-opus", name: "Claude 3 Opus", provider: "Anthropic", description: "FREE - Most capable Claude model" },
  // Google models
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", description: "FREE - Advanced multimodal" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", description: "FREE - Fast multimodal AI" },
  { id: "google/gemini-flash-1.5", name: "Gemini 1.5 Flash", provider: "Google", description: "FREE - Efficient multimodal model" },
  // X.AI models
  { id: "x-ai/grok-4", name: "Grok 4", provider: "X.AI", description: "FREE - Most capable Grok model" },
  { id: "x-ai/grok-4-fast", name: "Grok 4 Fast", provider: "X.AI", description: "FREE - Lightning-fast Grok" },
  { id: "x-ai/grok-4.1-fast", name: "Grok 4.1 Fast", provider: "X.AI", description: "FREE - Lightning-fast Grok" },
  { id: "x-ai/grok-4.1-fast:reasoning", name: "Grok 4.1 Fast Reasoning", provider: "X.AI", description: "FREE - Enhanced reasoning mode" },
  { id: "x-ai/grok-code-fast-1", name: "Grok Code Fast", provider: "X.AI", description: "FREE - Specialized for coding" },
  // Meta models
  { id: "meta-llama/llama-4-scout", name: "Llama 4 Scout", provider: "Meta", description: "FREE - Fast and efficient Llama 4" },
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", provider: "Meta", description: "FREE - Advanced Llama 4 model" },
  // DeepSeek models
  { id: "deepseek/deepseek-v3.1-terminus", name: "DeepSeek 3.1 Terminus", provider: "DeepSeek", description: "FREE - Advanced reasoning model" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", provider: "DeepSeek", description: "FREE - Efficient reasoning" },
  // Qwen models
  { id: "qwen/qwen3-max", name: "Qwen 3 Max", provider: "Qwen", description: "FREE - Top-tier reasoning model" },
  { id: "qwen/qwen3-coder-plus", name: "Qwen 3 Coder Plus", provider: "Qwen", description: "FREE - Advanced coding model" },
  { id: "qwen/qwen3-coder-flash", name: "Qwen 3 Coder Flash", provider: "Qwen", description: "FREE - Fast coding assistant" },
  { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B", provider: "Qwen", description: "FREE - Multilingual excellence" },
  { id: "qwen/qwen-turbo", name: "Qwen Turbo", provider: "Qwen", description: "FREE - Ultra-fast responses" },
  // Mistral models
  { id: "mistralai/mistral-large", name: "Mistral Large", provider: "Mistral AI", description: "FREE - European flagship model" },
  { id: "mistralai/mistral-medium-3.1", name: "Mistral Medium", provider: "Mistral AI", description: "FREE - Balanced capabilities" },
  // Other models
  { id: "minimax/minimax-m2", name: "Minimax M2", provider: "Minimax", description: "FREE - Advanced reasoning model" },
  { id: "moonshotai/kimi-k2-thinking", name: "Moonshot Kimi K2", provider: "Moonshot", description: "FREE - Deep thinking capabilities" },
  { id: "microsoft/phi-3-medium-128k-instruct", name: "Phi-3 Medium", provider: "Microsoft", description: "FREE - Compact and capable" },
  { id: "cohere/command-r-plus-08-2024", name: "Command R+", provider: "Cohere", description: "FREE - Enterprise-grade RAG" },
  { id: "z-ai/glm-4.6", name: "GLM 4.6", provider: "Z.ai", description: "FREE - Advanced reasoning model" },
  { id: "z-ai/glm-4.6:exacto", name: "GLM 4.6 Exacto", provider: "Z.ai", description: "FREE - Optimized precision model" },
];

/**
 * Handles GET /v1/models requests.
 * Returns a list of available models in OpenAI format.
 * 
 * Requirements: 6.1, 6.2
 */
function handleModels(): Response {
  const created = Math.floor(Date.now() / 1000);
  
  const models = {
    object: "list",
    data: INFINIAX_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: created,
      owned_by: m.provider.toLowerCase().replace(/\s+/g, "-"),
    })),
  };

  return new Response(JSON.stringify(models), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
// Main Router
// ============================================================================

/**
 * Main request handler - routes requests to appropriate handlers.
 * Requirements: 1.1, 7.2
 */
async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Health check / root endpoint (for Deno Deploy warm up)
    if (path === "/" && method === "GET") {
      return new Response(JSON.stringify({ 
        status: "ok", 
        service: "infiniax-deno-proxy",
        version: "1.0.0"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Route: POST /v1/chat/completions
    if (path === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req);
    }

    // Route: GET /v1/models
    if (path === "/v1/models" && method === "GET") {
      return handleModels();
    }

    // 404 for all other routes
    return errorResponse("Not Found", 404);
  } catch (error) {
    // Catch-all for unexpected errors at router level (Requirements: 7.2)
    console.error("Unexpected error in handler:", error);
    return errorResponse("Internal server error", 500);
  }
}

// ============================================================================
// Server Startup - Deno Deploy Compatible
// ============================================================================

// For Deno Deploy: export default handler
// Deno Deploy will automatically use this exported handler
export default handler;

// For local development: start server when run directly
// Note: On Deno Deploy, import.meta.main is false, so this won't run
// Deno Deploy uses the exported default handler instead
if (import.meta.main) {
  console.log(`infiniax-deno-proxy starting...`);
  
  if (!COOKIE) {
    console.error("Error: INFINIAX_COOKIE environment variable is not set.");
    Deno.exit(1);
  }

  Deno.serve({ port: PORT }, handler);
}
