// FILE: whatsNew/latestEntries.ts
// Purpose: The newest curated "What's new" releases, small enough to load at boot.
// Layer: static data read by `useWhatsNew` (the post-update prompt) and the sidebar
// help menu. The rest of the history lives in `entries.ts`, which loads lazily when
// the release notes open.
//
// Authoring guide: see `entries.ts`. New releases go here, newest first. When this
// list grows past three entries, move the oldest one to the top of `entries.ts`.
// `latestEntries.test.ts` fails if a newer release lands in `entries.ts` or the
// installed version is missing from this list.

import type { WhatsNewEntry } from "./logic";

export const LATEST_WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [
  {
    version: "1.5.0",
    date: "Nov 10",
    features: [
      {
        id: "remote-connections",
        title: "Connect to your agents with Synara Alto",
        description:
          "Pair computers running Synara on macOS, Windows x64, or Linux x64. Open remote workspaces, steer chats and handle approvals on the computer doing the work.",
        details:
          "Sign in to the same Synara account, open Connections and approve the pairing on the source computer. Keep it online for live work. The managed connector on a Mac requires macOS 15 or newer. iPhone and iPad support is coming soon.",
      },
      {
        id: "private-inbox-history",
        title: "Read your saved Inbox recaps offline",
        description:
          "A signed-in computer automatically saves daily activity recaps to your private Synara account. Open Inbox → Saved recaps to read them when the source computer is offline.",
        details:
          "Saved recaps include project names and activity totals. They do not include prompt or chat text and never appear on your public profile. You can delete a saved recap from the history.",
      },
      {
        id: "public-profile",
        title: "Share your Synara profile",
        description:
          "Alto lets you publish a profile at trysynara.com/@handle and choose what appears on it.",
      },
      {
        id: "daily-fixes",
        title: "More reliable browser and Git actions",
        description:
          "Browser automation keeps in-flight requests alive, unstaging a rename handles both paths, and Windows terminal paths and local images resolve correctly.",
      },
      {
        id: "account-and-interface",
        title: "Simpler sign-in and clearer settings",
        description:
          "A redesigned sign-in helps you connect your devices. The interface uses English, and Restore defaults counts both theme packs and the system UI font.",
      },
    ],
  },
  {
    version: "1.1.0",
    date: "Nov 2",
    features: [
      {
        id: "recovery",
        title: "Keep work moving after interruptions",
        description:
          "Ordinary running chats can continue after an unexpected server shutdown. Queued messages and subagent work recover more reliably.",
        details:
          "Recovery checks saved work before repeating operations. Approvals, unanswered questions, native subagents and managed tasks keep their own recovery rules. Claude Stop reports success only after verified runtime retirement.",
      },
      {
        id: "usage-limits",
        title: "Resume after usage limits",
        description:
          "An optional provider setting lets supported Codex and Claude tasks continue after a verified usage-limit reset.",
        details:
          "Off by default. The execution computer must be running, and the same account and model must remain available. Stop, manual sends and account changes cancel the wait; unknown or ambiguous limits stay manual.",
      },
      {
        id: "languages",
        title: "Use Synara in Spanish",
        description:
          "Choose English, Spanish or System in Settings → General → Language. The interface and native menus follow your preference.",
        details:
          "Your messages, provider output and code remain unchanged. An already loaded editor may need the offered reload to update its engine labels. Simplified Chinese is available in Synara Beta.",
      },
      {
        id: "chat-workspace",
        title: "Clearer chats and remembered panels",
        description:
          "Agent narration reads as prose, tool rows stay compact, and subagent rows show their model and effort. Each chat remembers its right-panel width.",
        details:
          "The new-chat action remains available without open tabs. Completed background work groups correctly, resumed timers stay accurate, and editor folders can be dragged into the composer.",
      },
      {
        id: "attachments",
        title: "Safer attachment recovery",
        description:
          "Failed photo preparation preserves your draft, private inline images recover safely, and desktop attachment uploads reach the correct server route.",
        details:
          "Unsupported native-review attachments are rejected without discarding work already accepted by the provider.",
      },
      {
        id: "providers-performance",
        title: "Provider fixes and lighter runtime state",
        description:
          "Pi supports current OpenAI sign-in while preserving existing SDK integrations. Cursor usage reads support safe-storage tokens. Runtime work retains less state and copies fewer computer frames.",
        details:
          "These are targeted reductions, not a whole-app memory or battery benchmark. Provider authentication and account isolation remain in force.",
      },
      {
        id: "offline-compaction",
        title: "Reclaim legacy database space offline",
        description:
          "The installed synara-compact-database command can compact a closed legacy database after verifying a private copy.",
        details:
          "Close every client first and supply the correct absolute database path. Scratch space is required; the command preserves retained rows and migration backups and never selects another app channel automatically.",
      },
    ],
  },
  {
    version: "1.0.9",
    date: "Oct 25",
    features: [
      {
        id: "native-editor-stable",
        title: "Native code editing in Stable",
        description:
          "Files, editable diffs and previews now share the Code OSS editing engine, with TypeScript and JavaScript intelligence, navigation, rename and debugging.",
        details:
          "Editor commands appear in Shortcuts and Keybindings. Existing save and conflict handling remain in charge; large previews keep their lightweight fallback. Debugging executes workspace code and downloads its debugger on first use.",
      },
      {
        id: "connectors-stable",
        title: "Connect your tools in Stable",
        description:
          "Settings → Connectors is now available in Stable. Sign in to supported remote MCP tools once and use them from compatible provider sessions.",
        details:
          "Provider support varies. New sessions receive connected tools; running sessions retain their original set. Stable and Beta keep separate credentials and data homes, and diagnostics remain Beta-only.",
      },
      {
        id: "stop-progress",
        title: "More reliable Stop and progress recovery",
        description:
          "Stop retries stay attached to their original runtime and turn. Command progress retains its identity across recovery, and provider errors show readable messages.",
        details:
          "A retry cannot stop a replacement runtime or a later turn. Uncertain or failed stops remain reported as such, while queued messages survive interrupt-only controls.",
      },
      {
        id: "goals-opencode",
        title: "Visible goals and isolated OpenCode sign-in",
        description:
          "A new /goal in an idle chat starts with a visible message. OpenCode sign-in and cold model discovery use private servers when the installed CLI supports them.",
        details:
          "Plan mode and existing goals retain their current behavior. Native clients can discover visible-goal startup support. Authentication terminals keep usable colors even when the server inherited a minimal terminal environment.",
      },
      {
        id: "workspace-refinements",
        title: "Project logos and clearer workspace controls",
        description:
          "Projects use detected local logos unless you chose a custom glyph. Hub workers no longer offer Snooze or Hub actions, and the landing pattern stays continuous beneath the composer.",
      },
      {
        id: "backup-platform",
        title: "Compressed recovery backups and accurate Mac requirements",
        description:
          "New pre-migration SQLite backups are compressed, with recovery support for both formats. Mac packages declare macOS 13 as their minimum and updater feeds enforce it.",
        details:
          "Backup creation still requires scratch space for the snapshot and compressed output. Existing backups remain readable. This release also updates the build toolchain to Bun 1.4.4 for security fixes.",
      },
    ],
  },
];
