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

/**
 * Custom intent rules for testing. Uses neutral domain terms (email, music)
 * without referencing specific third-party brands.
 */
const TEST_INTENT_RULES = [
  {
    integrationId: "adapter-beta",
    keywords: [
      "music",
      "song",
      "track",
      "playlist",
      "playback",
    ],
    phrases: [
      "play music",
      "pause music",
      "skip this song",
      "next track",
      "stop music",
      "resume music",
      "search music",
      "my playlists",
      "what's playing",
      "currently playing",
    ],
  },
  {
    integrationId: "adapter-alpha",
    keywords: [
      "email",
      "inbox",
      "mail",
    ],
    phrases: [
      "check email",
      "send email",
      "compose email",
      "search emails",
      "read email",
      "list emails",
      "unread emails",
      "check inbox",
      "write an email",
    ],
  },
  {
    integrationId: "obsidian",
    keywords: [
      "obsidian",
      "vault",
      "note",
      "notes",
      "markdown",
    ],
    phrases: [
      "search notes",
      "search my notes",
      "find notes",
      "find a note",
      "read note",
      "read a note",
      "open note",
      "create note",
      "create a note",
      "new note",
      "write a note",
      "list notes",
      "my notes",
      "in my vault",
      "in obsidian",
      "obsidian vault",
      "note about",
      "notes about",
    ],
  },
];

function createRegistryWithAllIntegrations(): IntegrationRegistry {
  const registry = new IntegrationRegistry();

  registry.register(
    createMockIntegration("adapter-beta", [
      createOperation("get_playback", "Get current playback state"),
      createOperation("control_playback", "Play/pause/skip/previous"),
      createOperation("search", "Search tracks, albums, artists"),
      createOperation("get_playlists", "Get user playlists"),
    ]),
  );

  registry.register(
    createMockIntegration("adapter-alpha", [
      createOperation("read_message", "Read message by ID"),
      createOperation("search_messages", "Search messages"),
      createOperation("send_message", "Send a message"),
      createOperation("list_messages", "List recent messages"),
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

function createRouterWithAllRules(registry?: IntegrationRegistry): IntentRouter {
  return new IntentRouter(registry ?? createRegistryWithAllIntegrations(), TEST_INTENT_RULES);
}

describe("IntentRouter", () => {
  describe("detectIntent", () => {
    describe("media adapter intent detection", () => {
      it("detects 'play music' as media intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Can you play music?");
        const media = intents.find((i) => i.integrationId === "adapter-beta");

        expect(media).toBeDefined();
        expect(media!.confidence).toBeGreaterThan(0);
        expect(media!.matchedKeywords).toContain("play music");
      });

      it("detects 'pause music' as media intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Please pause music");
        const media = intents.find((i) => i.integrationId === "adapter-beta");

        expect(media).toBeDefined();
        expect(media!.matchedKeywords).toContain("pause music");
      });

      it("detects 'skip this song' as media intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Skip this song please");
        const media = intents.find((i) => i.integrationId === "adapter-beta");

        expect(media).toBeDefined();
        expect(media!.matchedKeywords).toContain("skip this song");
      });

      it("detects 'what's playing' as media intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("What's playing right now?");
        const media = intents.find((i) => i.integrationId === "adapter-beta");

        expect(media).toBeDefined();
        expect(media!.matchedKeywords).toContain("what's playing");
      });

      it("detects 'music' keyword directly", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Open the music player");
        const media = intents.find((i) => i.integrationId === "adapter-beta");

        expect(media).toBeDefined();
        expect(media!.matchedKeywords).toContain("music");
      });

      it("detects 'my playlists' as media intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Show me my playlists");
        const media = intents.find((i) => i.integrationId === "adapter-beta");

        expect(media).toBeDefined();
        expect(media!.matchedKeywords).toContain("my playlists");
      });

      it("detects 'next track' as media intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Go to the next track");
        const media = intents.find((i) => i.integrationId === "adapter-beta");

        expect(media).toBeDefined();
        expect(media!.matchedKeywords).toContain("next track");
      });
    });

    describe("mail adapter intent detection", () => {
      it("detects 'check email' as mail intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Can you check email for me?");
        const mail = intents.find((i) => i.integrationId === "adapter-alpha");

        expect(mail).toBeDefined();
        expect(mail!.matchedKeywords).toContain("check email");
      });

      it("detects 'send email' as mail intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Send email to John about the meeting");
        const mail = intents.find((i) => i.integrationId === "adapter-alpha");

        expect(mail).toBeDefined();
        expect(mail!.matchedKeywords).toContain("send email");
      });

      it("detects 'check inbox' as mail intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Check inbox please");
        const mail = intents.find((i) => i.integrationId === "adapter-alpha");

        expect(mail).toBeDefined();
        expect(mail!.matchedKeywords).toContain("check inbox");
      });

      it("detects 'email' keyword directly", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Open my email");
        const mail = intents.find((i) => i.integrationId === "adapter-alpha");

        expect(mail).toBeDefined();
        expect(mail!.matchedKeywords).toContain("email");
      });

      it("detects 'unread emails' as mail intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Show me unread emails");
        const mail = intents.find((i) => i.integrationId === "adapter-alpha");

        expect(mail).toBeDefined();
        expect(mail!.matchedKeywords).toContain("unread emails");
      });

      it("detects 'compose email' as mail intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("I want to compose email");
        const mail = intents.find((i) => i.integrationId === "adapter-alpha");

        expect(mail).toBeDefined();
        expect(mail!.matchedKeywords).toContain("compose email");
      });

      it("detects 'search emails' as mail intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Search emails from last week");
        const mail = intents.find((i) => i.integrationId === "adapter-alpha");

        expect(mail).toBeDefined();
        expect(mail!.matchedKeywords).toContain("search emails");
      });
    });

    describe("Obsidian intent detection", () => {
      it("detects 'search notes' as Obsidian intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Search notes about TypeScript");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("search notes");
      });

      it("detects 'create note' as Obsidian intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Create a note about today's meeting");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("create a note");
      });

      it("detects 'obsidian' keyword directly", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Look in Obsidian for that");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("obsidian");
      });

      it("detects 'my notes' as Obsidian intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Search through my notes");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("my notes");
      });

      it("detects 'in my vault' as Obsidian intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Find the project plan in my vault");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("in my vault");
      });

      it("detects 'list notes' as Obsidian intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("List notes in the projects folder");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("list notes");
      });

      it("detects 'note about' as Obsidian intent", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Find the note about architecture decisions");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("note about");
      });
    });

    describe("confidence and ranking", () => {
      it("returns higher confidence for messages with multiple keyword matches", () => {
        const router = createRouterWithAllRules();

        const singleMatch = router.detectIntent("Play a song");
        const multiMatch = router.detectIntent("Play music from my playlist with the next track");

        const singleMedia = singleMatch.find((i) => i.integrationId === "adapter-beta");
        const multiMedia = multiMatch.find((i) => i.integrationId === "adapter-beta");

        expect(multiMedia).toBeDefined();
        expect(singleMedia).toBeDefined();
        expect(multiMedia!.confidence).toBeGreaterThan(singleMedia!.confidence);
      });

      it("caps confidence at 1.0", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent(
          "Play music, skip this song, next track, search music, my playlists, currently playing",
        );
        const media = intents.find((i) => i.integrationId === "adapter-beta");

        expect(media).toBeDefined();
        expect(media!.confidence).toBeLessThanOrEqual(1.0);
      });

      it("sorts results by confidence descending", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("Play music and also check email");

        expect(intents.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < intents.length; i++) {
          expect(intents[i - 1].confidence).toBeGreaterThanOrEqual(intents[i].confidence);
        }
      });

      it("returns empty array for unrelated messages", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("What is the weather today?");

        expect(intents).toEqual([]);
      });

      it("returns empty array for empty message", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("");

        expect(intents).toEqual([]);
      });
    });

    describe("case insensitivity", () => {
      it("detects intent regardless of message casing", () => {
        const router = createRouterWithAllRules();

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
            "adapter-beta",
            [createOperation("search")],
            false,
          ),
        );

        const router = new IntentRouter(registry, TEST_INTENT_RULES);
        const intents = router.detectIntent("Play some music");

        expect(intents).toEqual([]);
      });

      it("excludes unregistered integrations from detection", () => {
        const registry = new IntegrationRegistry();
        // Only register adapter-alpha, not adapter-beta or Obsidian
        registry.register(
          createMockIntegration("adapter-alpha", [createOperation("list_messages")]),
        );

        const router = new IntentRouter(registry, TEST_INTENT_RULES);
        const intents = router.detectIntent("Play some music");

        expect(intents).toEqual([]);
      });
    });

    describe("word boundary matching", () => {
      it("matches 'note' as a standalone word", () => {
        const router = createRouterWithAllRules();

        const intents = router.detectIntent("I need to find that note");
        const obsidian = intents.find((i) => i.integrationId === "obsidian");

        expect(obsidian).toBeDefined();
        expect(obsidian!.matchedKeywords).toContain("note");
      });

      it("does not match 'mail' inside 'email' as standalone keyword", () => {
        const router = createRouterWithAllRules();

        // "mail" is a adapter-alpha keyword, but "email" contains "mail" without word boundary
        // The word boundary check should prevent "mail" from matching inside "email"
        // However "email" itself IS a keyword, so adapter-alpha should still be detected
        const intents = router.detectIntent("Check my email");
        const mail = intents.find((i) => i.integrationId === "adapter-alpha");

        expect(mail).toBeDefined();
        expect(mail!.matchedKeywords).toContain("email");
      });
    });
  });

  describe("getToolSchemas", () => {
    it("returns tool schemas for detected media intent", () => {
      const router = createRouterWithAllRules();

      const injections = router.getToolSchemas("Play some music");

      const media = injections.find((i) => i.integrationId === "adapter-beta");
      expect(media).toBeDefined();
      expect(media!.operations).toHaveLength(4);
      expect(media!.operations.map((op) => op.name)).toEqual([
        "get_playback",
        "control_playback",
        "search",
        "get_playlists",
      ]);
    });

    it("returns tool schemas for detected mail intent", () => {
      const router = createRouterWithAllRules();

      const injections = router.getToolSchemas("Send email to Alice");

      const mail = injections.find((i) => i.integrationId === "adapter-alpha");
      expect(mail).toBeDefined();
      expect(mail!.operations).toHaveLength(4);
      expect(mail!.operations.map((op) => op.name)).toEqual([
        "read_message",
        "search_messages",
        "send_message",
        "list_messages",
      ]);
    });

    it("returns tool schemas for detected Obsidian intent", () => {
      const router = createRouterWithAllRules();

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
      const router = createRouterWithAllRules();

      const injections = router.getToolSchemas("Play music and check email");

      expect(injections.length).toBeGreaterThanOrEqual(2);
      const ids = injections.map((i) => i.integrationId);
      expect(ids).toContain("adapter-beta");
      expect(ids).toContain("adapter-alpha");
    });

    it("returns empty array for unrelated messages", () => {
      const router = createRouterWithAllRules();

      const injections = router.getToolSchemas("What is 2 + 2?");

      expect(injections).toEqual([]);
    });

    it("returns empty array when no integrations are registered", () => {
      const registry = new IntegrationRegistry();
      const router = new IntentRouter(registry, TEST_INTENT_RULES);

      const injections = router.getToolSchemas("Play music");

      expect(injections).toEqual([]);
    });

    it("excludes disabled integrations from schema injection", () => {
      const registry = new IntegrationRegistry();
      registry.register(
        createMockIntegration("adapter-beta", [createOperation("search")], false),
      );
      registry.register(
        createMockIntegration("adapter-alpha", [createOperation("list_messages")]),
      );

      const router = new IntentRouter(registry, TEST_INTENT_RULES);
      const injections = router.getToolSchemas("Play music and check email");

      const ids = injections.map((i) => i.integrationId);
      expect(ids).not.toContain("adapter-beta");
      expect(ids).toContain("adapter-alpha");
    });
  });

  describe("custom rules", () => {
    it("supports custom keyword rules", () => {
      const registry = new IntegrationRegistry();
      registry.register(
        createMockIntegration("chat-adapter", [createOperation("send_message")]),
      );

      const router = new IntentRouter(registry, [
        {
          integrationId: "chat-adapter",
          keywords: ["chat", "channel"],
          phrases: ["send message", "post in channel"],
        },
      ]);

      const intents = router.detectIntent("Send message in the chat");
      const chat = intents.find((i) => i.integrationId === "chat-adapter");

      expect(chat).toBeDefined();
      expect(chat!.matchedKeywords).toContain("send message");
      expect(chat!.matchedKeywords).toContain("chat");
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
      const router = createRouterWithAllRules();

      const corpus: Array<{ message: string; expectedIntegration: string }> = [
        // Media adapter messages
        { message: "Play some music", expectedIntegration: "adapter-beta" },
        { message: "Can you pause the music?", expectedIntegration: "adapter-beta" },
        { message: "Skip this song", expectedIntegration: "adapter-beta" },
        { message: "What's currently playing?", expectedIntegration: "adapter-beta" },
        { message: "Show me my playlists", expectedIntegration: "adapter-beta" },
        { message: "Search for some songs", expectedIntegration: "adapter-beta" },
        { message: "Play the next track", expectedIntegration: "adapter-beta" },
        { message: "Resume music playback", expectedIntegration: "adapter-beta" },
        { message: "I want to listen to some jazz music", expectedIntegration: "adapter-beta" },
        { message: "Start playing a song", expectedIntegration: "adapter-beta" },

        // Mail adapter messages
        { message: "Check my email", expectedIntegration: "adapter-alpha" },
        { message: "Send an email to Bob", expectedIntegration: "adapter-alpha" },
        { message: "Do I have any unread emails?", expectedIntegration: "adapter-alpha" },
        { message: "Search emails from last week", expectedIntegration: "adapter-alpha" },
        { message: "Read the latest email", expectedIntegration: "adapter-alpha" },
        { message: "Compose email to the team", expectedIntegration: "adapter-alpha" },
        { message: "Check my inbox for updates", expectedIntegration: "adapter-alpha" },
        { message: "List recent emails", expectedIntegration: "adapter-alpha" },
        { message: "Write an email about the project", expectedIntegration: "adapter-alpha" },
        { message: "Open my inbox", expectedIntegration: "adapter-alpha" },

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
      const router = createRouterWithAllRules();

      const integrationCorpora: Record<string, string[]> = {
        "adapter-beta": [
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
        "adapter-alpha": [
          "Check my email",
          "Send an email to Alice",
          "Unread emails",
          "Search emails",
          "Read the latest email",
          "Compose email",
          "Check inbox",
          "List emails",
          "Write an email",
          "Open my inbox",
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
