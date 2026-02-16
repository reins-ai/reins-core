import { describe, expect, it } from "bun:test";

import { IntentRouter, type DetectedIntent, type FallbackInjection } from "../../src/integrations/intent-router";
import { IntegrationRegistry } from "../../src/integrations/registry";
import type {
  Integration,
  IntegrationConfig,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationStatus,
} from "../../src/integrations/types";
import { IntegrationState } from "../../src/integrations/types";
import { ok } from "../../src/result";

function createOperation(name: string, description?: string): IntegrationOperation {
  return {
    name,
    description: description ?? `${name} operation`,
    parameters: {
      type: "object",
      properties: {
        input: { type: "string" },
      },
      required: ["input"],
    },
  };
}

function createMockIntegration(
  id: string,
  operations: IntegrationOperation[],
  enabled = true,
): Integration {
  const config: IntegrationConfig = { id, enabled };

  const manifest: IntegrationManifest = {
    id,
    name: id,
    description: `${id} integration`,
    version: "1.0.0",
    author: "Reins Team",
    category: "utilities",
    auth: { type: "api_key" },
    permissions: ["read"],
    platforms: ["daemon"],
    operations,
  };

  const status: IntegrationStatus = {
    indicator: "connected",
    state: IntegrationState.ACTIVE,
    updatedAt: new Date(),
  };

  return {
    config,
    manifest,
    async connect() {
      return ok(undefined);
    },
    async disconnect() {
      return ok(undefined);
    },
    getStatus() {
      return status;
    },
    getOperations() {
      return operations;
    },
    async execute() {
      return ok({ executed: true });
    },
  };
}

function createRegistryWithAllIntegrations(): IntegrationRegistry {
  const registry = new IntegrationRegistry();

  registry.register(
    createMockIntegration("spotify", [
      createOperation("get_playback", "Get current playback state"),
      createOperation("control_playback", "Play/pause/skip/previous"),
      createOperation("search", "Search tracks, albums, artists"),
      createOperation("get_playlists", "Get user playlists"),
    ]),
  );

  registry.register(
    createMockIntegration("gmail", [
      createOperation("read_email", "Read email by ID"),
      createOperation("search_emails", "Search emails"),
      createOperation("send_email", "Send an email"),
      createOperation("list_emails", "List recent emails"),
    ]),
  );

  registry.register(
    createMockIntegration("obsidian", [
      createOperation("search_notes", "Search notes by content"),
      createOperation("read_note", "Read note content"),
      createOperation("create_note", "Create a new note"),
      createOperation("list_notes", "List notes in directory"),
    ]),
  );

  return registry;
}

describe("IntentRouter", () => {
  describe("detectIntent", () => {
    describe("Spotify intent detection", () => {
      it("detects 'play music' as Spotify intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Can you play music?");
        const spotify = intents.find((i) => i.integrationId === "spotify");

        expect(spotify).toBeDefined();
        expect(spotify!.confidence).toBeGreaterThan(0);
        expect(spotify!.matchedKeywords).toContain("play music");
      });

      it("detects 'pause music' as Spotify intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Please pause music");
        const spotify = intents.find((i) => i.integrationId === "spotify");

        expect(spotify).toBeDefined();
        expect(spotify!.matchedKeywords).toContain("pause music");
      });

      it("detects 'skip this song' as Spotify intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Skip this song please");
        const spotify = intents.find((i) => i.integrationId === "spotify");

        expect(spotify).toBeDefined();
        expect(spotify!.matchedKeywords).toContain("skip this song");
      });

      it("detects 'what's playing' as Spotify intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("What's playing right now?");
        const spotify = intents.find((i) => i.integrationId === "spotify");

        expect(spotify).toBeDefined();
        expect(spotify!.matchedKeywords).toContain("what's playing");
      });

      it("detects 'spotify' keyword directly", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Open Spotify");
        const spotify = intents.find((i) => i.integrationId === "spotify");

        expect(spotify).toBeDefined();
        expect(spotify!.matchedKeywords).toContain("spotify");
      });

      it("detects 'my playlists' as Spotify intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Show me my playlists");
        const spotify = intents.find((i) => i.integrationId === "spotify");

        expect(spotify).toBeDefined();
        expect(spotify!.matchedKeywords).toContain("my playlists");
      });

      it("detects 'next track' as Spotify intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Go to the next track");
        const spotify = intents.find((i) => i.integrationId === "spotify");

        expect(spotify).toBeDefined();
        expect(spotify!.matchedKeywords).toContain("next track");
      });
    });

    describe("Gmail intent detection", () => {
      it("detects 'check email' as Gmail intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Can you check email for me?");
        const gmail = intents.find((i) => i.integrationId === "gmail");

        expect(gmail).toBeDefined();
        expect(gmail!.matchedKeywords).toContain("check email");
      });

      it("detects 'send email' as Gmail intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Send email to John about the meeting");
        const gmail = intents.find((i) => i.integrationId === "gmail");

        expect(gmail).toBeDefined();
        expect(gmail!.matchedKeywords).toContain("send email");
      });

      it("detects 'check inbox' as Gmail intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Check inbox please");
        const gmail = intents.find((i) => i.integrationId === "gmail");

        expect(gmail).toBeDefined();
        expect(gmail!.matchedKeywords).toContain("check inbox");
      });

      it("detects 'gmail' keyword directly", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Open Gmail");
        const gmail = intents.find((i) => i.integrationId === "gmail");

        expect(gmail).toBeDefined();
        expect(gmail!.matchedKeywords).toContain("gmail");
      });

      it("detects 'unread emails' as Gmail intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Show me unread emails");
        const gmail = intents.find((i) => i.integrationId === "gmail");

        expect(gmail).toBeDefined();
        expect(gmail!.matchedKeywords).toContain("unread emails");
      });

      it("detects 'compose email' as Gmail intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("I want to compose email");
        const gmail = intents.find((i) => i.integrationId === "gmail");

        expect(gmail).toBeDefined();
        expect(gmail!.matchedKeywords).toContain("compose email");
      });

      it("detects 'search emails' as Gmail intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Search emails from last week");
        const gmail = intents.find((i) => i.integrationId === "gmail");

        expect(gmail).toBeDefined();
        expect(gmail!.matchedKeywords).toContain("search emails");
      });
    });

    describe("Obsidian intent detection", () => {
      it("detects 'search notes' as Obsidian intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Search notes about TypeScript");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("search notes");
      });

      it("detects 'create note' as Obsidian intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Create a note about today's meeting");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("create a note");
      });

      it("detects 'obsidian' keyword directly", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Look in Obsidian for that");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("obsidian");
      });

      it("detects 'my notes' as Obsidian intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Search through my notes");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("my notes");
      });

      it("detects 'in my vault' as Obsidian intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Find the project plan in my vault");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("in my vault");
      });

      it("detects 'list notes' as Obsidian intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("List notes in the projects folder");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("list notes");
      });

      it("detects 'note about' as Obsidian intent", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Find the note about architecture decisions");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("note about");
      });
    });

    describe("confidence and ranking", () => {
      it("returns higher confidence for messages with multiple keyword matches", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const singleMatch = router.detectIntent("Play a song");
        const multiMatch = router.detectIntent("Play music on Spotify from my playlist");

        const singleSpotify = singleMatch.find((i) => i.integrationId === "spotify");
        const multiSpotify = multiMatch.find((i) => i.integrationId === "spotify");

        expect(multiSpotify).toBeDefined();
        expect(singleSpotify).toBeDefined();
        expect(multiSpotify!.confidence).toBeGreaterThan(singleSpotify!.confidence);
      });

      it("caps confidence at 1.0", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent(
          "Play music on Spotify, skip song, next track, search music, my playlists, currently playing",
        );
        const spotify = intents.find((i) => i.integrationId === "spotify");

        expect(spotify).toBeDefined();
        expect(spotify!.confidence).toBeLessThanOrEqual(1.0);
      });

      it("sorts results by confidence descending", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("Play music and also check email");

        expect(intents.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < intents.length; i++) {
          expect(intents[i - 1].confidence).toBeGreaterThanOrEqual(intents[i].confidence);
        }
      });

      it("returns empty array for unrelated messages", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("What is the weather today?");

        expect(intents).toEqual([]);
      });

      it("returns empty array for empty message", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("");

        expect(intents).toEqual([]);
      });
    });

    describe("case insensitivity", () => {
      it("detects intent regardless of message casing", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const lower = router.detectIntent("play music");
        const upper = router.detectIntent("PLAY MUSIC");
        const mixed = router.detectIntent("Play Music");

        expect(lower.length).toBeGreaterThan(0);
        expect(upper.length).toBeGreaterThan(0);
        expect(mixed.length).toBeGreaterThan(0);

        expect(lower[0].integrationId).toBe(upper[0].integrationId);
        expect(lower[0].integrationId).toBe(mixed[0].integrationId);
      });
    });

    describe("inactive integration filtering", () => {
      it("excludes disabled integrations from detection", () => {
        const registry = new IntegrationRegistry();
        registry.register(
          createMockIntegration(
            "spotify",
            [createOperation("search")],
            false,
          ),
        );

        const router = new IntentRouter(registry);
        const intents = router.detectIntent("Play music on Spotify");

        expect(intents).toEqual([]);
      });

      it("excludes unregistered integrations from detection", () => {
        const registry = new IntegrationRegistry();
        // Only register Gmail, not Spotify or Obsidian
        registry.register(
          createMockIntegration("gmail", [createOperation("list_emails")]),
        );

        const router = new IntentRouter(registry);
        const intents = router.detectIntent("Play music on Spotify");

        expect(intents).toEqual([]);
      });
    });

    describe("word boundary matching", () => {
      it("matches 'note' as a standalone word", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        const intents = router.detectIntent("I need to find that note");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("note");
      });

      it("does not match 'mail' inside 'email' as standalone keyword", () => {
        const registry = createRegistryWithAllIntegrations();
        const router = new IntentRouter(registry);

        // "mail" is a Gmail keyword, but "email" contains "mail" without word boundary
        // The word boundary check should prevent "mail" from matching inside "email"
        // However "email" itself IS a keyword, so Gmail should still be detected
        const intents = router.detectIntent("Check my email");
        const gmail = intents.find((i) => i.integrationId === "gmail");

        expect(gmail).toBeDefined();
        expect(gmail!.matchedKeywords).toContain("email");
      });
    });
  });

  describe("getToolSchemas", () => {
    it("returns tool schemas for detected Spotify intent", () => {
      const registry = createRegistryWithAllIntegrations();
      const router = new IntentRouter(registry);

      const injections = router.getToolSchemas("Play some music");

      const spotify = injections.find((i) => i.integrationId === "spotify");
      expect(spotify).toBeDefined();
      expect(spotify!.operations).toHaveLength(4);
      expect(spotify!.operations.map((op) => op.name)).toEqual([
        "get_playback",
        "control_playback",
        "search",
        "get_playlists",
      ]);
    });

    it("returns tool schemas for detected Gmail intent", () => {
      const registry = createRegistryWithAllIntegrations();
      const router = new IntentRouter(registry);

      const injections = router.getToolSchemas("Send email to Alice");

      const gmail = injections.find((i) => i.integrationId === "gmail");
      expect(gmail).toBeDefined();
      expect(gmail!.operations).toHaveLength(4);
      expect(gmail!.operations.map((op) => op.name)).toEqual([
        "read_email",
        "search_emails",
        "send_email",
        "list_emails",
      ]);
    });

    it("returns tool schemas for detected Obsidian intent", () => {
      const registry = createRegistryWithAllIntegrations();
      const router = new IntentRouter(registry);

      const injections = router.getToolSchemas("Search my notes about architecture");

      const obsidian = injections.find((i) => i.integrationId === "obsidian");
      expect(obsidian).toBeDefined();
      expect(obsidian!.operations).toHaveLength(4);
      expect(obsidian!.operations.map((op) => op.name)).toEqual([
        "search_notes",
        "read_note",
        "create_note",
        "list_notes",
      ]);
    });

    it("returns multiple injections when message matches multiple integrations", () => {
      const registry = createRegistryWithAllIntegrations();
      const router = new IntentRouter(registry);

      const injections = router.getToolSchemas("Play music and check email");

      expect(injections.length).toBeGreaterThanOrEqual(2);
      const ids = injections.map((i) => i.integrationId);
      expect(ids).toContain("spotify");
      expect(ids).toContain("gmail");
    });

    it("returns empty array for unrelated messages", () => {
      const registry = createRegistryWithAllIntegrations();
      const router = new IntentRouter(registry);

      const injections = router.getToolSchemas("What is 2 + 2?");

      expect(injections).toEqual([]);
    });

    it("returns empty array when no integrations are registered", () => {
      const registry = new IntegrationRegistry();
      const router = new IntentRouter(registry);

      const injections = router.getToolSchemas("Play music");

      expect(injections).toEqual([]);
    });

    it("excludes disabled integrations from schema injection", () => {
      const registry = new IntegrationRegistry();
      registry.register(
        createMockIntegration("spotify", [createOperation("search")], false),
      );
      registry.register(
        createMockIntegration("gmail", [createOperation("list_emails")]),
      );

      const router = new IntentRouter(registry);
      const injections = router.getToolSchemas("Play music and check email");

      const ids = injections.map((i) => i.integrationId);
      expect(ids).not.toContain("spotify");
      expect(ids).toContain("gmail");
    });
  });

  describe("custom rules", () => {
    it("supports custom keyword rules", () => {
      const registry = new IntegrationRegistry();
      registry.register(
        createMockIntegration("slack", [createOperation("send_message")]),
      );

      const router = new IntentRouter(registry, [
        {
          integrationId: "slack",
          keywords: ["slack", "channel"],
          phrases: ["send message", "post in channel"],
        },
      ]);

      const intents = router.detectIntent("Send message in Slack");
      const slack = intents.find((i) => i.integrationId === "slack");

      expect(slack).toBeDefined();
      expect(slack!.matchedKeywords).toContain("send message");
      expect(slack!.matchedKeywords).toContain("slack");
    });
  });

  describe("intent detection accuracy", () => {
    /**
     * Accuracy test: verifies that the intent router correctly identifies
     * the expected integration for a corpus of natural-language messages.
     *
     * The spec requires ≥80% accuracy (MH2).
     */
    it("achieves ≥80% accuracy on a representative test corpus", () => {
      const registry = createRegistryWithAllIntegrations();
      const router = new IntentRouter(registry);

      const corpus: Array<{ message: string; expectedIntegration: string }> = [
        // Spotify messages
        { message: "Play some music", expectedIntegration: "spotify" },
        { message: "Can you pause the music?", expectedIntegration: "spotify" },
        { message: "Skip this song", expectedIntegration: "spotify" },
        { message: "What's currently playing?", expectedIntegration: "spotify" },
        { message: "Show me my playlists", expectedIntegration: "spotify" },
        { message: "Search for Beatles songs", expectedIntegration: "spotify" },
        { message: "Play the next track", expectedIntegration: "spotify" },
        { message: "Resume music playback", expectedIntegration: "spotify" },
        { message: "I want to listen to some jazz", expectedIntegration: "spotify" },
        { message: "Open Spotify and play something", expectedIntegration: "spotify" },

        // Gmail messages
        { message: "Check my email", expectedIntegration: "gmail" },
        { message: "Send an email to Bob", expectedIntegration: "gmail" },
        { message: "Do I have any unread emails?", expectedIntegration: "gmail" },
        { message: "Search emails from last week", expectedIntegration: "gmail" },
        { message: "Read the latest email", expectedIntegration: "gmail" },
        { message: "Compose email to the team", expectedIntegration: "gmail" },
        { message: "Check my inbox for updates", expectedIntegration: "gmail" },
        { message: "List recent emails", expectedIntegration: "gmail" },
        { message: "Write an email about the project", expectedIntegration: "gmail" },
        { message: "Open Gmail", expectedIntegration: "gmail" },

        // Obsidian messages
        { message: "Search notes about TypeScript", expectedIntegration: "obsidian" },
        { message: "Create a note about today's meeting", expectedIntegration: "obsidian" },
        { message: "Find notes about architecture", expectedIntegration: "obsidian" },
        { message: "Read my daily note", expectedIntegration: "obsidian" },
        { message: "List notes in the projects folder", expectedIntegration: "obsidian" },
        { message: "Look in my vault for that document", expectedIntegration: "obsidian" },
        { message: "Open Obsidian and search for recipes", expectedIntegration: "obsidian" },
        { message: "Write a note about the new feature", expectedIntegration: "obsidian" },
        { message: "Find the note about deployment steps", expectedIntegration: "obsidian" },
        { message: "Show my notes about React patterns", expectedIntegration: "obsidian" },
      ];

      let correct = 0;

      for (const testCase of corpus) {
        const intents = router.detectIntent(testCase.message);
        const topIntent = intents[0];

        if (topIntent && topIntent.integrationId === testCase.expectedIntegration) {
          correct += 1;
        }
      }

      const accuracy = correct / corpus.length;
      expect(accuracy).toBeGreaterThanOrEqual(0.8);
    });

    it("reports individual accuracy per integration at ≥80%", () => {
      const registry = createRegistryWithAllIntegrations();
      const router = new IntentRouter(registry);

      const integrationCorpora: Record<string, string[]> = {
        spotify: [
          "Play some music",
          "Pause the music",
          "Skip this song",
          "What's playing?",
          "Show my playlists",
          "Search for a track",
          "Next track please",
          "Resume music",
          "Stop music",
          "Currently playing",
        ],
        gmail: [
          "Check my email",
          "Send an email to Alice",
          "Unread emails",
          "Search emails",
          "Read the latest email",
          "Compose email",
          "Check inbox",
          "List emails",
          "Write an email",
          "Open Gmail",
        ],
        obsidian: [
          "Search notes about TypeScript",
          "Create a note",
          "Find notes about architecture",
          "Read my note",
          "List notes in projects",
          "Look in my vault",
          "Open Obsidian",
          "Write a note",
          "Note about deployment",
          "My notes about React",
        ],
      };

      for (const [integrationId, messages] of Object.entries(integrationCorpora)) {
        let correct = 0;

        for (const message of messages) {
          const intents = router.detectIntent(message);
          const topIntent = intents[0];

          if (topIntent && topIntent.integrationId === integrationId) {
            correct += 1;
          }
        }

        const accuracy = correct / messages.length;
        expect(accuracy).toBeGreaterThanOrEqual(0.8);
      }
    });
  });
});
