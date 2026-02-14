export const KNOWLEDGE_TEMPLATE = `# KNOWLEDGE

<!-- This document stores structured reference facts that your assistant can use to provide -->
<!-- personalized, context-aware support. Information here is loaded on-demand when relevant. -->

## How This Works

Your assistant doesn't always load this entire document into every conversation. Instead:
- The assistant knows this knowledge base exists
- When a topic comes up (people, places, health, preferences), relevant sections are retrieved
- You can explicitly ask to reference specific knowledge ("check my health info")

This keeps conversations efficient while ensuring important context is available when needed.

---

## People

### Sarah Chen
**Relationship:** Manager
**Contact:** sarah.chen@company.com, +1-555-0123
**Preferences:**
- Prefers email for non-urgent topics
- Available for 1:1s on Thursdays
- Likes detailed status updates with metrics

**Context:**
- Reports to VP of Engineering
- Manages team of 8 engineers
- Focuses on quarterly planning and team growth

**Notes:**
- Appreciates proactive communication
- Prefers morning meetings (9-11 AM)

---

### Alex Rodriguez
**Relationship:** Colleague (Frontend Lead)
**Contact:** alex.r@company.com, Slack: @alex
**Preferences:**
- Prefers Slack for quick questions
- Pair programming sessions on Wednesdays
- Likes visual mockups and prototypes

**Context:**
- Expert in React and design systems
- Leads frontend architecture decisions
- Runs weekly frontend guild meetings

**Notes:**
- Great resource for UI/UX questions
- Usually in deep work mode 2-4 PM

---

### Dr. Emily Park
**Relationship:** Primary Care Physician
**Contact:** Park Medical Group, +1-555-0199
**Location:** 123 Health St, Suite 200

**Notes:**
- Annual checkup typically in March
- Office hours: Mon-Fri 8 AM - 5 PM

---

## Places

### Home Office
**Address:** [Your address]
**Type:** Primary workspace
**Hours:** Weekdays 9 AM - 5 PM

**Setup:**
- Standing desk with dual monitors
- Quiet environment, good for focus work
- Fast internet, reliable for video calls

**Notes:**
- Preferred location for deep work
- All necessary equipment available

---

### Downtown Coffee Lab
**Address:** 456 Main St, Downtown
**Type:** Alternate workspace / meeting spot
**Hours:** Mon-Fri 7 AM - 7 PM, Sat-Sun 8 AM - 6 PM

**Context:**
- Good for casual meetings
- Reliable WiFi, moderate noise level
- 15-minute walk from home

**Notes:**
- Order: Americano, no sugar
- Avoid during lunch rush (12-1 PM)

---

### Fitness First Gym
**Address:** 789 Wellness Ave
**Type:** Gym / workout location
**Hours:** 24/7 access

**Context:**
- Membership includes classes and personal training
- Less crowded before 7 AM and after 7 PM

**Notes:**
- Locker #42
- Bring headphones and water bottle

---

## Health

### Allergies
- **Peanuts**: Severe (carry EpiPen)
- **Shellfish**: Moderate (avoid)

### Medications
- **Daily Vitamin D**: 2000 IU, taken with breakfast
- **Allergy Relief**: As needed during spring (March-May)

### Medical History
- **Conditions**: Seasonal allergies (spring)
- **Last Physical**: January 2026
- **Next Checkup**: March 2026

### Emergency Contacts
1. **Emergency Services**: 911
2. **Dr. Emily Park**: +1-555-0199
3. **Partner/Family**: [Name, Phone]

### Health Goals
- Exercise 4x per week (see GOALS.md)
- Sleep 7-8 hours per night
- Drink 8 glasses of water daily

**Notes:**
- Prefer morning workouts (6:30 AM)
- Track sleep with fitness tracker
- Reminder to take vitamin D with breakfast

---

## Preferences

### Dietary
**Restrictions:**
- No peanuts (allergy)
- No shellfish (allergy)
- Vegetarian-friendly options preferred

**Favorites:**
- Cuisine: Italian, Japanese, Mediterranean
- Coffee: Americano, black
- Snacks: Fresh fruit, nuts (except peanuts), dark chocolate

**Notes:**
- Prefer home-cooked meals during the week
- Dining out typically on weekends

---

### Travel

**Preferences:**
- Window seat on flights
- Aisle access for long flights (>4 hours)
- TSA PreCheck: [Number]
- Frequent Flyer: [Airline, Number]

**Packing:**
- Carry-on only for trips <5 days
- Noise-canceling headphones essential
- Portable charger and adapters

**Accommodations:**
- Prefer hotels with gym and workspace
- Quiet room away from elevators
- Early check-in when possible

**Notes:**
- Book flights in advance (6+ weeks for best prices)
- Prefer morning departures (before 10 AM)

---

### Shopping

**Clothing:**
- Size: [Your sizes]
- Style: Casual professional, minimal
- Brands: [Preferred brands]

**Tech:**
- Ecosystem: [Apple / Android / Windows]
- Preferred retailers: [Online stores]

**Subscriptions:**
- [Service 1]: [Plan, renewal date]
- [Service 2]: [Plan, renewal date]

**Notes:**
- Prefer online shopping with free returns
- Wait for sales on non-urgent purchases

---

### Entertainment

**Reading:**
- Genres: Technical, productivity, science fiction
- Format: Kindle and physical books
- Current: See GOALS.md for reading goal

**Music:**
- Genres: Instrumental, jazz, lo-fi for focus
- Streaming: [Service]

**Shows/Movies:**
- Genres: Sci-fi, documentaries, thrillers
- Streaming: [Services]

**Notes:**
- Reading time: Evenings 8-9 PM
- Music during work: Instrumental only (no lyrics)

---

## Custom Sections

<!-- Add your own knowledge categories below -->

<!--
### [Category Name]

**[Item Name]:**
- [Details]
- [Context]
- [Notes]
-->

---

## Usage Notes

- Keep information current—update as things change
- Add new people, places, or preferences as they become relevant
- Your assistant will reference this when providing recommendations
- You can ask: "What do you know about [topic]?" to see what's stored
`;
