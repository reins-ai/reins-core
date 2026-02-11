import type { OAuthProviderDefinition } from "./types";

const GLM_BASE_URL = "https://api.z.ai/api/paas/v4";

export const glmOAuthProviderDefinition: OAuthProviderDefinition = {
  id: "glm",
  authModes: ["api_key"],
  metadata: {
    name: "GLM",
    description: "GLM (Z.AI) provider using API key authentication",
    authModes: ["api_key"],
    apiKey: {
      envVar: "ZAI_API_KEY",
      baseUrl: GLM_BASE_URL,
    },
    endpoints: [GLM_BASE_URL],
    icon: "glm",
  },
};
