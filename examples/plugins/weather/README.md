# Weather Plugin Example

This example plugin demonstrates the Reins plugin API with `@reins/sdk`:

- Plugin manifest (`reins-plugin.json`)
- Tool registration via `defineTool`
- Event handling with `conversation_start`
- Permission declaration (`network_access`)
- Plugin testing with `MockPluginContext`

## Structure

- `src/index.ts` - Plugin entrypoint and lifecycle hooks
- `src/weather-tool.ts` - Weather tool with argument validation
- `src/weather-data.ts` - Mock weather and forecast data helpers
- `tests/weather.test.ts` - Plugin/tool unit tests

## Run

```bash
bun install
bun run typecheck
bun test
```
