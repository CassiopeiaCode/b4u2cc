import { ProxyConfig, UpstreamConfig } from "./config.ts";
import { OpenAIChatRequest } from "./types.ts";
import { logRequest } from "./logging.ts";

/**
 * 根据客户端请求的模型名选择上游配置。
 * 如果找到匹配的 nameModel，则返回对应的 UpstreamConfig；
 * 否则，如果存在旧配置（upstreamBaseUrl），则返回一个合成的 UpstreamConfig；
 * 否则抛出错误。
 */
export function selectUpstreamConfig(
  config: ProxyConfig,
  clientModel: string,
): UpstreamConfig {
  // 在多组配置中查找
  for (const upstreamConfig of config.upstreamConfigs) {
    if (upstreamConfig.nameModel === clientModel) {
      return upstreamConfig;
    }
  }

  // 如果没有多组配置，但存在旧配置，则使用旧配置
  if (config.upstreamBaseUrl) {
    return {
      baseUrl: config.upstreamBaseUrl,
      apiKey: config.upstreamApiKey,
      requestModel: config.upstreamModelOverride ?? clientModel,
      nameModel: clientModel,
    };
  }

  throw new Error(`No upstream configuration found for model "${clientModel}"`);
}

export async function callUpstream(
  body: OpenAIChatRequest,
  upstreamConfig: UpstreamConfig,
  requestTimeoutMs: number,
  requestId: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  const headers = new Headers({
    "content-type": "application/json",
  });
  if (upstreamConfig.apiKey) {
    headers.set("authorization", `Bearer ${upstreamConfig.apiKey}`);
  }

  await logRequest(requestId, "debug", "Sending upstream request", {
    url: upstreamConfig.baseUrl,
    upstreamRequestBody: body,
  });

  let response: Response;
  try {
    response = await fetch(upstreamConfig.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  await logRequest(requestId, "debug", "Upstream response received", { status: response.status });
  if (!response.body) {
    throw new Error("Upstream response has no body");
  }

  return response;
}
