/**
 * Structured extraction examples that teach the LLM how to use
 * `search_documents` for extract-to-table, find-all-mentions,
 * and compare-documents tasks.
 */
export const STRUCTURED_EXTRACTION_EXAMPLES = `
## Structured Extraction with Documents

When users want structured data from their indexed documents, use \`search_documents\` with structured output formatting.

### Extract to Table

**User:** "Extract all dates and amounts from my invoices"

1. Call \`search_documents({ query: "invoice date amount total", top_k: 10 })\`
2. Parse each returned chunk for date and monetary values
3. Format results as a Markdown table:

| Date | Invoice # | Amount | Source |
|------|-----------|--------|--------|
| 2026-01-15 | INV-001 | $1,200.00 | invoices/january.pdf |
| 2026-02-01 | INV-002 | $850.00 | invoices/february.pdf |

Always include the source document so the user can verify.

### Find All Mentions

**User:** "Find every mention of 'ACME Corp' in my contracts"

1. Call \`search_documents({ query: "ACME Corp", top_k: 20 })\`
2. List each occurrence with its source file and surrounding context:

**contracts/service-agreement.pdf** (3 mentions)
- Section 2.1: "...ACME Corp shall provide quarterly reports..."
- Section 5.3: "...liability of ACME Corp is limited to..."
- Exhibit A: "...ACME Corp, a Delaware corporation..."

**contracts/nda.pdf** (1 mention)
- Preamble: "...between User and ACME Corp ('Disclosing Party')..."

Group by source document and include section references when available.

### Compare Documents

**User:** "Compare the payment terms in contract A vs contract B"

1. Call \`search_documents({ query: "payment terms", source: "contract-a.pdf" })\`
2. Call \`search_documents({ query: "payment terms", source: "contract-b.pdf" })\`
3. Present as a side-by-side comparison table:

| Aspect | Contract A | Contract B |
|--------|-----------|-----------|
| Payment deadline | Net 30 | Net 60 |
| Late fee | 1.5% monthly | 2% monthly |
| Currency | USD | EUR |
| Early payment discount | 2% if paid in 10 days | None |

Highlight key differences and flag any terms that may conflict.
`;

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

### Memory

**Status:** enabled
**Aggressiveness:** moderate

**Permissions:**
- ✅ Remember user details, preferences, and important facts
- ✅ Recall memories when relevant to the conversation
- ✅ Update or correct existing memories when user clarifies
- ✅ Delete memories when user asks to forget something
- ✅ List memories by type when user wants to review what's remembered

**Natural Language → Action Mapping:**
- "Remember that..." → \`memory({ action: "remember", content: "..." })\`
- "Recall my preferences for X" → \`memory({ action: "recall", query: "preferences X" })\`
- "Update my X to Y" → first recall to find id, then \`memory({ action: "update", id: "...", content: "Y" })\`
- "Forget that I X" → first recall to find id, then \`memory({ action: "delete", id: "..." })\`
- "What have you remembered about me?" → \`memory({ action: "list" })\`
- "Show my preferences" → \`memory({ action: "list", type: "preference" })\`
- "Show my decisions" → \`memory({ action: "list", type: "decision" })\`

**When to Remember Proactively:**
- User states a preference explicitly ("I prefer X", "I like Y", "I always...")
- User shares an important personal fact (job title, family, location, health)
- A key decision is made ("we decided to...", "going forward I'll...")
- User corrects the assistant about a fact they've shared before

**Memory Types to Use:**
- \`fact\` — general facts about the user
- \`preference\` — user preferences and style choices
- \`decision\` — decisions made during conversations
- \`episode\` — notable events or experiences shared
- \`skill\` — skills or expertise the user has mentioned
- \`entity\` — people, places, or organizations important to the user

**Notes:**
- Always confirm after remembering: "Got it, I'll remember that [brief summary]"
- Do not store sensitive financial or medical data
- When unsure if something is worth remembering, remember it anyway — the user can delete it

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
` + STRUCTURED_EXTRACTION_EXAMPLES;
