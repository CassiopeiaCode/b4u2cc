import { ClaudeMessage, ClaudeRequest } from "./types.ts";
import { ProxyConfig } from "./config.ts";
import { logRequest } from "./logging.ts";
import { countTokensWithTiktoken } from "./tiktoken.ts";

export interface TokenCountResult {
  input_tokens: number; // 最新官方 API 字段名
  token_count?: number; // 保持向后兼容
  tokens?: number; // 保持向后兼容
  output_tokens?: number;
}

/**
 * 使用 tiktoken 进行精确的 token 估算
 */
export function estimateTokensFromText(text: string, model: string = "cl100k_base"): number {
  try {
    const tokens = countTokensWithTiktoken(text, model);
    // 防御性处理：如果第三方库返回了 NaN/Infinity，则退回到简单估算
    if (!Number.isFinite(tokens) || tokens < 0) {
      return Math.ceil(text.length / 4);
    }
    return tokens;
  } catch (error) {
    // 如果 tiktoken 失败，回退到简单的字符估算
    return Math.ceil(text.length / 4);
  }
}

/**
 * 从 Claude 消息中提取所有文本内容
 */
export function extractTextFromMessages(messages: ClaudeMessage[]): string {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content
      .map((block) => {
        if (block.type === "text") {
          return block.text;
        }
        if (block.type === "tool_use") {
          return `<invoke name="${block.name}">${JSON.stringify(block.input)}</invoke>`;
        }
        if (block.type === "tool_result") {
          const contentStr = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
          return `<tool_result>${contentStr}</tool_result>`;
        }
        return "";
      })
      .join("");
  }).join("\n");
}

/**
 * 使用本地 tiktoken 算法计算 token 数量
 */
export async function estimateTokensLocally(
  request: ClaudeRequest,
  config: ProxyConfig,
  requestId: string,
): Promise<TokenCountResult> {
  const allText = extractTextFromMessages(request.messages);
  let estimatedTokens = estimateTokensFromText(allText, request.model);

  // 添加系统提示的 token
  if (request.system) {
    const systemText = typeof request.system === "string"
      ? request.system
      : request.system.map(block => block.type === "text" ? block.text : "").join("");
    estimatedTokens += estimateTokensFromText(systemText, request.model);
  }

  // 添加工具定义的 token
  if (request.tools && request.tools.length > 0) {
    const toolsText = JSON.stringify(request.tools);
    const toolsTokens = estimateTokensFromText(toolsText, request.model);
    estimatedTokens += toolsTokens;
    
    await logRequest(requestId, "debug", "Added tool tokens", {
      toolsCount: request.tools.length,
      toolsTextLength: toolsText.length,
      toolsTokens,
    });
  }

  // 应用 token 倍数（防御 NaN/非法配置）
  const multiplier = Number.isFinite(config.tokenMultiplier) && config.tokenMultiplier > 0
    ? config.tokenMultiplier
    : 1.0;
  const rawAdjusted = estimatedTokens * multiplier;
  const adjustedTokens = Math.max(
    1,
    Math.ceil(
      Number.isFinite(rawAdjusted)
        ? rawAdjusted
        : estimatedTokens,
    ),
  );

  await logRequest(requestId, "debug", "Local token estimation with tiktoken", {
    textLength: allText.length,
    estimatedTokens,
    multiplier,
    adjustedTokens,
    model: request.model,
    hasTools: !!(request.tools && request.tools.length > 0),
  });

  return {
    input_tokens: adjustedTokens, // 使用最新官方 API 字段名
    token_count: adjustedTokens, // 保持向后兼容
    tokens: adjustedTokens, // 保持向后兼容
  };
}

/**
 * 主要的 token 计数函数，仅使用本地 tiktoken
 */
export async function countTokens(
  request: ClaudeRequest,
  config: ProxyConfig,
  requestId: string,
): Promise<TokenCountResult> {
  await logRequest(requestId, "debug", "Using local tiktoken for token counting", {
    model: request.model,
    messageCount: request.messages.length,
  });

  // 仅使用本地 tiktoken 计算
  return await estimateTokensLocally(request, config, requestId);
}

/**
 * 仅使用本地方法计算 token（不调用 Claude API）
 */
export async function countTokensLocally(
  request: ClaudeRequest,
  config: ProxyConfig,
  requestId: string,
): Promise<TokenCountResult> {
  return await estimateTokensLocally(request, config, requestId);
}
