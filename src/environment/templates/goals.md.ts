export const GOALS_TEMPLATE = `# GOALS

<!-- This document tracks your long-term objectives and helps your assistant support your progress. -->
<!-- Goals are reviewed during weekly routines and can be referenced in daily planning. -->

## How to Use This Document

Each goal should include:
- **State**: active, completed, or paused
- **Target**: What you're trying to achieve
- **Progress**: Current status (percentage, milestone, or qualitative)
- **Tracking Method**: How progress is measured
- **Assistant Role**: How your assistant should help

---

## Active Goals

### Launch New Feature (Q1 2026)

**State:** active
**Target:** Ship user authentication and profile management by March 31, 2026
**Progress:** 75% (auth complete, profile UI in progress)
**Tracking Method:** Milestone completion (4 milestones total, 3 done)

**Assistant Role:**
- Remind about upcoming milestone deadlines
- Surface blockers during weekly review
- Suggest focus time for implementation work
- Track related tasks and meetings

**Milestones:**
- [x] Design authentication flow (completed Jan 15)
- [x] Implement backend auth service (completed Feb 1)
- [x] Build login/signup UI (completed Feb 10)
- [ ] Profile management UI (due Feb 28)

**Notes:**
- Backend is solid, focus is now on frontend polish
- Need to schedule user testing before launch

---

### Read 2 Books Per Month

**State:** active
**Target:** Read 24 books in 2026 (2 per month average)
**Progress:** 3 books completed (Jan: 2, Feb: 1 so far)
**Tracking Method:** Book count and reading sessions logged

**Assistant Role:**
- Remind to schedule reading time
- Track books completed
- Suggest books based on interests (see KNOWLEDGE.md)
- Celebrate milestones (every 5 books)

**Current Book:**
- "Atomic Habits" by James Clear (60% complete)

**Completed:**
1. "The Pragmatic Programmer" (Jan 8)
2. "Deep Work" (Jan 24)
3. "Designing Data-Intensive Applications" (Feb 5)

**Notes:**
- Reading time works best in evenings (8-9pm)
- Prefer technical and productivity books

---

### Improve Fitness Consistency

**State:** active
**Target:** Exercise 4x per week consistently for 3 months
**Progress:** Week 3 of 12 (on track)
**Tracking Method:** Weekly workout count

**Assistant Role:**
- Remind to schedule workout sessions
- Track weekly completion rate
- Celebrate weekly streaks
- Suggest recovery days when needed

**Weekly Log:**
- Week 1: 4 workouts ✅
- Week 2: 5 workouts ✅
- Week 3: 3 workouts (in progress)

**Notes:**
- Best workout times: 6:30 AM or 6:00 PM
- Prefer morning workouts on weekdays

---

## Paused Goals

### Learn Spanish

**State:** paused
**Target:** Reach conversational fluency (B1 level)
**Progress:** A2 level (basic conversations)
**Tracking Method:** Duolingo streak and conversation practice

**Reason for Pause:** Prioritizing work project through Q1, will resume in April

**Assistant Role When Resumed:**
- Daily practice reminders
- Track streak and lesson completion
- Suggest conversation practice opportunities

---

## Completed Goals

### Migrate to New Task System

**State:** completed
**Completed:** January 15, 2026
**Target:** Fully migrate from old task manager to Reins
**Final Progress:** 100% (all tasks migrated, old system deactivated)

**Outcome:**
- 247 tasks migrated successfully
- New workflow established and documented
- Old system archived

---

## Goal Template

<!-- Copy this template to add new goals -->

<!--
### [Goal Name]

**State:** active | paused | completed
**Target:** [What you're trying to achieve]
**Progress:** [Current status]
**Tracking Method:** [How progress is measured]

**Assistant Role:**
- [How should your assistant help?]
- [What reminders or tracking?]
- [What milestones to celebrate?]

**Notes:**
- [Any relevant context]
-->

---

## Weekly Review Integration

During the weekly review routine (see ROUTINES.md), your assistant will:
1. Summarize progress on all active goals
2. Flag goals that are behind schedule or need attention
3. Celebrate completed milestones
4. Prompt reflection on goal priorities

## Notes

- Keep goals specific and measurable
- Update progress regularly (weekly review is a good time)
- Don't hesitate to pause goals when priorities shift
- Celebrate progress, not just completion
`;
