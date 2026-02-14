export const HEARTBEAT_TEMPLATE = `# HEARTBEAT

<!-- The heartbeat is a periodic self-check where your assistant reviews upcoming events, -->
<!-- pending tasks, and routines to surface anything that needs attention. -->

## Configuration

### Interval
**Check Every:** 30 minutes

<!-- Options: 15, 30, 60, 120 minutes -->
<!-- Shorter intervals = more responsive but higher API costs -->
<!-- Longer intervals = lower costs but less proactive -->

### Active Hours
**Start:** 7:00 AM
**End:** 10:00 PM

<!-- Heartbeat only runs during these hours. Outside this window, checks are skipped. -->

## Acknowledgment Behavior

### HEARTBEAT_OK Response
When the heartbeat runs and finds nothing requiring attention, you can respond with just:

\`\`\`
HEARTBEAT_OK
\`\`\`

This acknowledgment is automatically stripped and suppressed—no notification is shown to you. Use this to confirm the heartbeat ran without cluttering your interface.

### When to Show Output
The assistant should only produce visible output when:
- A calendar event is coming up soon (within next 2 hours)
- A reminder is due or overdue
- A routine is due to run
- A goal needs attention or review
- An important pattern or anomaly is detected

## Suppression Rules

### Duplicate Detection
**Dedupe Window:** 4 hours

If the same alert or reminder has been surfaced within the dedupe window, suppress it. This prevents repetitive notifications about the same item.

**Examples:**
- "Meeting with Sarah at 2pm" should only appear once, not every heartbeat
- "Overdue: Submit expense report" should not repeat every 30 minutes

### Skip Logic
Skip the entire heartbeat check if:
- Current time is outside active hours
- User is actively in a conversation (optional—prevents interruptions)
- System is in "do not disturb" mode (if implemented)

## Check Items

During each heartbeat, review:

1. **Calendar**: Events in next 2 hours, conflicts, missing prep time
2. **Reminders**: Due or overdue items, upcoming deadlines
3. **Routines**: Any routines scheduled to run now (see ROUTINES.md)
4. **Goals**: Weekly review trigger, milestone approaching (see GOALS.md)
5. **Patterns**: Unusual gaps, overloaded schedule, missed habits

## Output Format

When the heartbeat has actionable information, use this structure:

\`\`\`
🔔 Heartbeat Check — [Time]

📅 Calendar:
- [Event 1]
- [Event 2]

✅ Reminders:
- [Reminder 1]
- [Reminder 2]

🔄 Routines:
- [Routine due now]

💡 Notes:
- [Any observations or suggestions]
\`\`\`

Keep it concise. The goal is to surface what matters, not to overwhelm.

## Customization

<!-- Uncomment to adjust behavior: -->

<!-- ### Notification Threshold
**Minimum Priority:** medium
Only surface high or medium priority items, skip low priority.
-->

<!-- ### Context Awareness
**Suppress During:** meetings, focus blocks
Check calendar before showing heartbeat output.
-->

<!-- ### Smart Timing
**Prefer:** natural breaks (top of hour, between meetings)
Delay non-urgent heartbeat output to avoid interruptions.
-->
`;
