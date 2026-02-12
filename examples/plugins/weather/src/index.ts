import { definePlugin } from "@reins/sdk";
import type { PluginManifest } from "@reins/sdk";

import { weatherTool } from "./weather-tool";

const manifest: PluginManifest = {
  name: "weather",
  version: "1.0.0",
  description: "Get current weather and forecasts for any location",
  author: "Reins Team",
  permissions: ["network_access"],
  entryPoint: "src/index.ts",
  license: "MIT",
};

export default definePlugin({
  manifest,
  activate(context) {
    context.registerTool(weatherTool);
    context.on("conversation_start", () => {
      context.log.info("Weather plugin activated for conversation");
    });
    context.log.info("Weather plugin loaded successfully");
  },
  deactivate() {
    // No teardown required for the reference plugin.
  },
});
