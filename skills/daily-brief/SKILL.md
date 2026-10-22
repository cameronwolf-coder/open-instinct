---
name: daily-brief
description: Proactive morning text for the owner. Use when a scheduled job says to run the daily brief, when the owner asks "what's my day", or when setting up or changing the morning text. Pulls weather, today's calendar, unread mail that matters, open threads and pending approvals into one short message. Created with schedule_create during onboarding.
---

# Daily brief

One text, sent at the time the owner chose, that lets them start the day
without opening anything. It is a scheduled run in the owner conversation, so
the principal is the owner and all owner tools are available.

## Setup

During onboarding, or when asked: `schedule_create` with a 5-field cron in the
owner's timezone and the prompt "Run the daily-brief skill for the owner."
Example for 8am Eastern: cron `0 8 * * *`, tz `America/New_York`. Weekdays only
is `0 8 * * 1-5`. To change the time, `schedule_list`, `schedule_delete` the old
job, create the new one, and confirm in one line.

## Collect

Do these in order; skip any source that is not connected and do not mention
the gap unless the owner has asked for it before.

1. Weather: `web_fetch` `https://wttr.in/<city>?format=3` for a one-line
   summary, or `?format=j1` for the high, low and rain chance. City from memory.
2. Calendar: today's events via the calendar app tool. Note the first event's
   time, anything with a location that needs travel, and video calls.
3. Mail: unread since yesterday evening that needs a reply or decision (skill
   `email-triage`, read step only). Count the rest.
4. Open threads: `memory_read` and yesterday's journal for things you are
   waiting on (a reply from Sam's Instinct, a delivery, a booking hold).
5. Approvals: anything you asked the owner that is still unanswered. Repeat
   the ask in one line with the same wording.
6. Scheduled items for today you created (check-ins, rides) so the owner knows
   you have them.
7. Systems, only when the `hermes_status` and `wiki_updates` tools exist:
   `hermes_status` for jobs failing or stale, and `wiki_updates` since the
   previous brief for what changed (new decisions, project pages, notable
   agent runs). Name what broke and the one or two changes worth knowing;
   skip routine receipts.

## Write

4 to 8 lines, plain prose, no markdown, no headings, no emojis unless the owner
uses them. Order: greeting with weather, calendar, mail, waiting on, approvals,
systems, one offer. Times in the owner's timezone. Skip empty sections. If nothing at
all is happening, send two lines.

Agent: Morning, Maria. 61 and clear, rain after 4. Three things today: Lena
at 10 on Zoom, dentist at 2:30 on Mass Ave, and dinner with Sam at Nopa, 7pm.
Two emails need you, both from the bookstore about the reading date. Still
waiting on Priya's Instinct about Saturday brunch. One thing pending: book the
JetBlue flight for $412, want me to go ahead? Want me to order a car for the dentist?

Agent: Morning. 48 and grey. Nothing on the calendar and nothing in mail
needs you. I'm around if anything comes up.

## Quiet rules

- Respect quiet hours from memory. If the scheduled time falls inside them, do
  not send; tell the owner once and offer to move the job.
- If the owner already texted you this morning before the job fires, fold the
  brief into that thread instead of sending a second text.
- Never include the content of other people's messages beyond sender and
  topic.

## After sending

`journal_append` one line: "Daily brief sent, N events, N emails flagged, N
approvals open." Do not write to memory from the brief.

## Do not

- Do not send more than one brief a day unless asked.
- Do not read mail bodies aloud. Sender and ask only.
- Do not add tasks the owner did not ask for; offers are fine, actions are not.
