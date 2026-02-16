import type {
  ClawHubCategoriesResponse,
  ClawHubSkillDetailResponse,
  ClawHubSkillsResponse,
} from "../../../src/marketplace/clawhub/api-types";

/**
 * Realistic mock data matching actual ClawHub API response shapes.
 * Used by integration tests to verify the full client → source → cache pipeline.
 */

export const mockClawHubSkillsResponse: ClawHubSkillsResponse = {
  skills: [
    {
      slug: "smart-calendar-sync",
      name: "Smart Calendar Sync",
      author: "openclaw",
      description: "Bidirectional calendar synchronization with Google Calendar, Outlook, and Apple Calendar. Supports recurring events, timezone handling, and conflict resolution.",
      installCount: 4_821,
      trustLevel: "verified",
      categories: ["productivity", "calendar"],
      latestVersion: "2.4.1",
      updatedAt: "2026-02-10T14:32:00.000Z",
    },
    {
      slug: "git-commit-assistant",
      name: "Git Commit Assistant",
      author: "devtools-collective",
      description: "AI-powered commit message generation from staged diffs. Follows conventional commits format with scope detection.",
      installCount: 12_340,
      trustLevel: "trusted",
      categories: ["developer-tools", "git"],
      latestVersion: "1.8.0",
      updatedAt: "2026-02-12T09:15:00.000Z",
    },
    {
      slug: "voice-memo-transcriber",
      name: "Voice Memo Transcriber",
      author: "audio-labs",
      description: "Transcribes voice memos to structured notes with speaker diarization and automatic summarization.",
      installCount: 987,
      trustLevel: "community",
      categories: ["audio", "notes"],
      latestVersion: "0.9.3",
      updatedAt: "2026-01-28T18:45:00.000Z",
    },
  ],
  total: 147,
  page: 1,
  pageSize: 20,
};

export const mockClawHubSearchResponse: ClawHubSkillsResponse = {
  skills: [
    {
      slug: "smart-calendar-sync",
      name: "Smart Calendar Sync",
      author: "openclaw",
      description: "Bidirectional calendar synchronization with Google Calendar, Outlook, and Apple Calendar.",
      installCount: 4_821,
      trustLevel: "verified",
      categories: ["productivity", "calendar"],
      latestVersion: "2.4.1",
      updatedAt: "2026-02-10T14:32:00.000Z",
    },
    {
      slug: "meeting-scheduler",
      name: "Meeting Scheduler",
      author: "productivity-hub",
      description: "Intelligent meeting scheduling with availability detection and timezone-aware suggestions.",
      installCount: 2_105,
      trustLevel: "trusted",
      categories: ["productivity", "calendar"],
      latestVersion: "1.2.0",
      updatedAt: "2026-02-08T11:20:00.000Z",
    },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
};

export const mockClawHubDetailResponse: ClawHubSkillDetailResponse = {
  slug: "smart-calendar-sync",
  name: "Smart Calendar Sync",
  author: "openclaw",
  description: "Bidirectional calendar synchronization with Google Calendar, Outlook, and Apple Calendar.",
  installCount: 4_821,
  trustLevel: "verified",
  categories: ["productivity", "calendar"],
  latestVersion: "2.4.1",
  updatedAt: "2026-02-10T14:32:00.000Z",
  fullDescription: "Smart Calendar Sync provides seamless bidirectional synchronization between your local calendar and cloud providers. It handles recurring events, timezone conversions, and conflict resolution automatically.",
  readme: "# Smart Calendar Sync\n\nA powerful calendar synchronization skill for Reins.\n\n## Features\n\n- Google Calendar integration\n- Outlook support\n- Apple Calendar support\n- Recurring event handling\n- Timezone-aware scheduling",
  versions: [
    { version: "2.4.1", publishedAt: "2026-02-10T14:32:00.000Z", changelog: "Fix timezone edge case for DST transitions" },
    { version: "2.4.0", publishedAt: "2026-02-01T10:00:00.000Z", changelog: "Add Apple Calendar support" },
    { version: "2.3.0", publishedAt: "2026-01-15T08:00:00.000Z" },
  ],
  requiredTools: ["curl", "jq"],
  homepage: "https://github.com/openclaw/smart-calendar-sync",
  license: "MIT",
};

export const mockClawHubCategoriesResponse: ClawHubCategoriesResponse = {
  categories: [
    { id: "cat-prod", name: "Productivity", slug: "productivity", count: 42 },
    { id: "cat-dev", name: "Developer Tools", slug: "developer-tools", count: 38 },
    { id: "cat-audio", name: "Audio & Voice", slug: "audio", count: 15 },
    { id: "cat-notes", name: "Notes & Writing", slug: "notes", count: 23 },
    { id: "cat-cal", name: "Calendar", slug: "calendar", count: 11 },
  ],
};
