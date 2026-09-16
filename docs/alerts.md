# Alerts — what is wrong with the box right now

A NAS is quiet furniture: nobody opens its pages on a good day. So the box has
to be the one to speak up. `agent/src/alerts.ts` keeps a list of **conditions
that are true right now** — not a log, not a feed of events — and mk-drive is
what carries them to a person.

## What it watches

| key | when | how loud |
| --- | --- | --- |
| `pool:<name>:state` | the pool is not ONLINE | critical |
| `pool:<name>:full` | 90 % full (95 % critical) | warning / critical |
| `disk:<id>:smart` | SMART says it failed, or reallocated or pending sectors | critical (pending: warning) |
| `disk:<id>:temp` | 55 °C or hotter | warning |
| `scan:<pool>` | the last scrub or resilver did not come back clean | warning |
| `replication:<id>` | the last copy to another host failed | warning |
| `backup:settings` | the last settings backup failed | warning |
| `update:available` | a newer signed release is out | info |
| `update:check` | the box could not reach GitHub to look | info |

The thresholds live in `alerts.ts` and nowhere else; the `health` verb uses the
same constants, so a line on the Storage page and an alert can never disagree.

## How one behaves

- **Raised** when it becomes true, with `since` — and `since` stays put while
  the condition lasts, across agent restarts and reboots, so "degraded since
  Tuesday" is true.
- **Confirmed** a minute later. Anything younger may be a blip (a disk that
  reappears, a pool that briefly reads busy), and nothing should wake a person
  for it. The drive only notifies confirmed alerts.
- **Acknowledged** when someone says they have seen it: it stays open, because
  the problem is still there, but it stops nagging. If it clears and happens
  again, the acknowledgement is gone and it nags again.
- **Cleared** when it stops being true, and kept for a month as history.
- **Never flaps**: a pool raised at 90 % is held until it drops under 88 %, a
  disk raised at 55 °C until it cools under 50 °C.

## When it looks

Every five minutes (`MK_NAS_ALERTS_EVERY`), and at once when ZFS reports
something that matters — a disk faulted, checksums failed — so a pulled disk
shows up in seconds rather than at the next sweep. Disk readings come from the
same standby-aware path as everything else: **a sleeping disk is never woken**
to check on it; its last reading is used.

## Reading them

```
sudo mk-nas alerts
```

or the verbs `alerts` and `alert.ack` over the socket, which is what the drive
uses. Both are reads of what the timer already worked out, so a page may poll
them as often as it likes.

## Why the agent does not send anything

It runs as root. Mail servers, push endpoints and chat webhooks all mean
outbound credentials and outbound connections in the most privileged process on
the box. The agent decides and remembers; **mk-drive** — which already has the
person, their browser and their settings — is what delivers.
