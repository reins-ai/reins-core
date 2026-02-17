import type {
  ClawHubBrowseResponse,
  ClawHubDetailResponse,
  ClawHubSearchResponse,
} from "../../../src/marketplace/clawhub/api-types";

/**
 * Realistic mock data matching actual ClawHub API response shapes.
 * Used by integration tests to verify the full client → source → cache pipeline.
 */

export const mockClawHubSkillsResponse: ClawHubBrowseResponse = {
  items: [
    {
      slug: "smart-calendar-sync",
      displayName: "Smart Calendar Sync",
      summary: "Bidirectional calendar synchronization with Google Calendar, Outlook, and Apple Calendar. Supports recurring events, timezone handling, and conflict resolution.",
      tags: { latest: "2.4.1" },
      stats: {
        installsAllTime: 4_821,
        installsCurrent: 210,
        downloads: 10_000,
        comments: 0,
        stars: 50,
        versions: 3,
      },
      updatedAt: 1_771_287_920_000,
      latestVersion: {
        version: "2.4.1",
        createdAt: 1_771_287_920_000,
        changelog: "",
      },
    },
    {
      slug: "git-commit-assistant",
      displayName: "Git Commit Assistant",
      summary: "AI-powered commit message generation from staged diffs. Follows conventional commits format with scope detection.",
      tags: { latest: "1.8.0" },
      stats: {
        installsAllTime: 12_340,
        installsCurrent: 1_240,
      },
      updatedAt: 1_771_432_900_000,
      latestVersion: {
        version: "1.8.0",
        createdAt: 1_771_432_900_000,
      },
    },
    {
      slug: "voice-memo-transcriber",
      displayName: "Voice Memo Transcriber",
      summary: "Transcribes voice memos to structured notes with speaker diarization and automatic summarization.",
      tags: { latest: "0.9.3" },
      stats: {
        installsAllTime: 987,
        installsCurrent: 130,
      },
      updatedAt: 1_770_627_900_000,
      latestVersion: {
        version: "0.9.3",
        createdAt: 1_770_627_900_000,
      },
    },
  ],
  nextCursor: "cursor-2",
};

export const mockClawHubSearchResponse: ClawHubSearchResponse = {
  results: [
    {
      score: 3.66,
      slug: "smart-calendar-sync",
      displayName: "Smart Calendar Sync",
      summary: "Bidirectional calendar synchronization with Google Calendar, Outlook, and Apple Calendar.",
      version: "2.4.1",
      updatedAt: 1_771_287_920_000,
    },
    {
      score: 2.12,
      slug: "meeting-scheduler",
      displayName: "Meeting Scheduler",
      summary: "Intelligent meeting scheduling with availability detection and timezone-aware suggestions.",
      version: "1.2.0",
      updatedAt: 1_771_102_000_000,
    },
  ],
};

export const mockClawHubDetailResponse: ClawHubDetailResponse = {
  skill: {
    slug: "smart-calendar-sync",
    displayName: "Smart Calendar Sync",
    summary: "Bidirectional calendar synchronization with Google Calendar, Outlook, and Apple Calendar.",
    tags: { latest: "2.4.1" },
    stats: {
      installsAllTime: 4_821,
      installsCurrent: 210,
      downloads: 10_000,
      comments: 0,
      stars: 50,
      versions: 3,
    },
    createdAt: 1_771_200_000_000,
    updatedAt: 1_771_287_920_000,
  },
  latestVersion: {
    version: "2.4.1",
    createdAt: 1_771_287_920_000,
    changelog: "Fix timezone edge case for DST transitions",
  },
  owner: {
    handle: "openclaw",
    userId: "user-openclaw",
    displayName: "OpenClaw",
    image: "https://example.com/avatar.png",
  },
  moderation: null,
};
