import type { OAuthProviderDefinition } from "./types";

const KIMI_BASE_URL = "https://api.moonshot.ai/v1";

export const kimiOAuthProviderDefinition: OAuthProviderDefinition = {
  id: "kimi",
  authModes: ["api_key"],
  metadata: {
    name: "Kimi",
    description: "Kimi (Moonshot) provider using API key authentication",
    authModes: ["api_key"],
    apiKey: {
      envVar: "MOONSHOT_API_KEY",
      baseUrl: KIMI_BASE_URL,
    },
    endpoints: [KIMI_BASE_URL, "https://api.moonshot.cn/v1"],
    icon: "kimi",
  },
};
