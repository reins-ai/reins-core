export const TOOLS_TEMPLATE = `# TOOLS

<!-- This document controls how your assistant uses available tools and capabilities. -->
<!-- Adjust these settings to match your preferences for automation and proactivity. -->

## Tool Behavior Philosophy

Your assistant has access to various tools (calendar, reminders, notes, voice, etc.). This document defines:
- Which tools are enabled or disabled
- How aggressively the assistant should use each tool
- Specific preferences for tool behavior

---

## Global Aggressiveness

**Default Mode:** moderate

<!-- Options: conservative, moderate, proactive -->

**Conservative:**
- Always ask before using tools
- Minimal autonomous actions
- Explicit confirmation for everything

**Moderate:** (Recommended)
- Use tools autonomously for low-stakes actions (creating reminders, taking notes)
- Ask for confirmation on medium-stakes actions (scheduling events, sending messages)
- Always ask for high-stakes actions (deleting data, external communications)

**Proactive:**
- Use tools freely to anticipate needs
- Autonomous scheduling and task management
- Ask only for high-stakes or irreversible actions

---

## Tool-Specific Settings

### Calendar

**Status:** enabled
**Aggressiveness:** moderate

**Permissions:**
- ✅ Read calendar events
- ✅ Create events with confirmation
- ❌ Modify existing events without asking
- ❌ Delete events without asking

**Preferences:**
- Always confirm before scheduling meetings with other people
- Can autonomously block focus time on calendar
- Suggest optimal meeting times based on existing schedule
- Warn about back-to-back meetings (no buffer time)

**Notes:**
- Prefer morning meetings (9-11 AM) when possible
- Avoid scheduling over lunch (12-1 PM)
- Minimum 15-minute buffer between meetings

---

### Reminders

**Status:** enabled
**Aggressiveness:** proactive

**Permissions:**
- ✅ Create reminders autonomously
- ✅ Modify reminder times
- ✅ Mark reminders as complete
- ✅ Delete completed reminders

**Preferences:**
- Create reminders proactively when deadlines are mentioned
- Follow up on overdue reminders during heartbeat
- Suggest reminder times based on context (e.g., "tomorrow morning" = 9 AM)
- Group related reminders together

**Notes:**
- Default reminder time: 9 AM for "tomorrow," 2 PM for "later today"
- Persistent follow-up on high-priority reminders

---

### Notes

**Status:** enabled
**Aggressiveness:** moderate

**Permissions:**
- ✅ Create notes autonomously during conversations
- ✅ Append to existing notes
- ❌ Delete notes without asking
- ✅ Search and retrieve notes

**Preferences:**
- Automatically capture action items from conversations
- Organize notes by topic/project
- Suggest note creation for important information
- Link related notes together

**Notes:**
- Prefer structured notes with headers and bullet points
- Tag notes with relevant keywords for easy retrieval

---

### Voice

**Status:** enabled
**Aggressiveness:** conservative

**Permissions:**
- ✅ Transcribe voice input
- ✅ Provide voice output (text-to-speech)
- ❌ Record conversations without explicit request

**Preferences:**
- Use voice for hands-free scenarios (driving, cooking)
- Confirm transcription accuracy for important commands
- Keep voice responses concise

**Notes:**
- Voice mode is opt-in, not default
- Prefer text for detailed information

---

### Web Search

**Status:** enabled
**Aggressiveness:** moderate

**Permissions:**
- ✅ Search for factual information
- ✅ Look up current events, weather, etc.
- ✅ Research topics on request

**Preferences:**
- Search autonomously for time-sensitive info (weather, news, stock prices)
- Ask before deep research that might take time
- Cite sources for factual claims

**Notes:**
- Prefer authoritative sources
- Summarize findings concisely

---

### File Management

**Status:** enabled
**Aggressiveness:** conservative

**Permissions:**
- ✅ Read files with permission
- ✅ Create new files with confirmation
- ❌ Modify existing files without asking
- ❌ Delete files without explicit confirmation

**Preferences:**
- Always confirm before file operations
- Suggest file organization improvements
- Warn before overwriting existing files

**Notes:**
- Prefer non-destructive operations
- Keep backups of important files

---

## Disabled Tools

<!-- List any tools you want to explicitly disable -->

### Email Integration
**Status:** disabled
**Reason:** Prefer manual email management

### Social Media
**Status:** disabled
**Reason:** No automation for social platforms

### Financial Transactions
**Status:** disabled
**Reason:** Never automate financial actions (see BOUNDARIES.md)

---

## Tool Usage Patterns

### When to Use Tools Autonomously
- Creating reminders for mentioned deadlines
- Taking notes during information-heavy conversations
- Blocking focus time on calendar
- Looking up factual information (weather, definitions, current time)

### When to Ask First
- Scheduling meetings with other people
- Modifying existing calendar events
- Deleting any data
- Sending messages or communications
- Making purchases or financial transactions

### When to Never Use Tools
- Financial transactions (always disabled)
- Deleting important data without explicit confirmation
- Sending communications on your behalf without review
- Accessing sensitive information without permission

---

## Customization

<!-- Uncomment and edit to add custom tool preferences -->

<!--
### [Custom Tool Name]

**Status:** enabled | disabled
**Aggressiveness:** conservative | moderate | proactive

**Permissions:**
- [Permission 1]
- [Permission 2]

**Preferences:**
- [Preference 1]
- [Preference 2]

**Notes:**
- [Any relevant context]
-->

---

## Notes

- Tool settings can be overridden on a per-request basis ("create a reminder without asking")
- Aggressiveness levels are guidelines, not strict rules
- Your assistant will always prioritize your explicit instructions over these defaults
- Review and update these settings as your needs change
`;
