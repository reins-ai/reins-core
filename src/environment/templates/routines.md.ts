export const ROUTINES_TEMPLATE = `# ROUTINES

<!-- Routines are recurring rituals that run automatically at specified times. -->
<!-- They integrate with the heartbeat system to provide consistent, predictable support. -->

## How Routines Work

Each routine has:
- **Name**: What the routine is called
- **Trigger**: When it should run (time-based or event-based)
- **Output Contract**: What the assistant should provide
- **Actions**: Specific steps or checks to perform

Routines are evaluated during heartbeat checks. When a routine's trigger condition is met, the assistant executes the defined actions and provides the specified output.

---

## Morning Kickoff

**Trigger:** First heartbeat after 7:00 AM on weekdays

**Output Contract:**
- Today's calendar summary with event times and titles
- Overdue and due-today reminders
- Weather forecast for the day
- One motivational focus statement

**Actions:**
1. Query calendar for today's events
2. Check reminders due today or overdue
3. Fetch weather for user's location
4. Generate brief focus statement based on calendar density

**Example Output:**
\`\`\`
☀️ Good morning! Here's your day:

📅 Calendar (3 events):
- 9:00 AM: Team standup (30 min)
- 11:00 AM: Project review with Sarah (1 hour)
- 2:00 PM: Client call (45 min)

✅ Reminders:
- Submit expense report (due today)
- Review Q1 goals (overdue by 2 days)

🌤️ Weather: Partly cloudy, high of 72°F

💡 Focus: Moderate day with good focus blocks between meetings.
\`\`\`

---

## Evening Wind-Down

**Trigger:** First heartbeat after 6:00 PM on weekdays

**Output Contract:**
- Summary of completed tasks/events
- Incomplete items carried forward
- Tomorrow's first event preview
- Evening reflection prompt (optional)

**Actions:**
1. Review today's calendar events (mark as completed)
2. Check for incomplete reminders
3. Preview tomorrow's first event
4. Suggest any prep needed for tomorrow

**Example Output:**
\`\`\`
🌙 Evening wrap-up:

✅ Completed today:
- Team standup
- Project review with Sarah
- Client call

⏭️ Carried forward:
- Submit expense report (now overdue)

📅 Tomorrow starts with:
- 8:30 AM: Leadership meeting (1 hour)

💡 Prep needed: Review leadership meeting agenda and Q4 metrics.
\`\`\`

---

## Weekly Review

**Trigger:** First heartbeat after 5:00 PM on Sunday

**Output Contract:**
- Week summary (events attended, tasks completed)
- Goal progress update (see GOALS.md)
- Upcoming week preview (major events, deadlines)
- Reflection questions

**Actions:**
1. Summarize past week's calendar and tasks
2. Review active goals and update progress
3. Preview next week's calendar highlights
4. Prompt for weekly reflection

**Example Output:**
\`\`\`
📊 Weekly Review — Week of [Date]

📅 This week:
- 12 meetings attended
- 8 tasks completed
- 3 focus blocks protected

🎯 Goal Progress:
- "Launch new feature": 60% → 75% (on track)
- "Read 2 books/month": 1/2 completed (behind)

📅 Next week preview:
- Monday: All-hands meeting (10 AM)
- Wednesday: Project deadline
- Friday: 1:1 with manager

💭 Reflection:
- What went well this week?
- What would you do differently?
- What's your top priority for next week?
\`\`\`

---

## Custom Routine Template

<!-- Copy this template to add your own routines -->

<!--
## [Routine Name]

**Trigger:** [When should this run?]

**Output Contract:**
- [What should the assistant provide?]
- [What format or structure?]

**Actions:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Example Output:**
\`\`\`
[Show what the output looks like]
\`\`\`
-->

---

## Notes

- Routines run during heartbeat checks, so they respect the heartbeat active hours and interval settings.
- If multiple routines trigger at the same time, they are combined into a single output.
- Routines can reference other documents (GOALS.md, KNOWLEDGE.md) for context.
- Use HEARTBEAT_OK acknowledgment when no routines are due.
`;
