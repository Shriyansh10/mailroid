# Mailroid — working notes

## Product philosophy

> **A feature that exists but cannot be discovered is equivalent to a feature
> that does not exist.**

Every workflow must satisfy six conditions, in order. A feature that stops at
the first one is **not finished**, however green the type check is:

| | |
|---|---|
| **Implemented** | The backend works. |
| **Visible** | The user can see its state where it applies. |
| **Discoverable** | The user meets it naturally, without documentation or guessing which icon to press. |
| **Contextual** | It appears where it is relevant, pre-filled with what is already known. |
| **Progressive** | The simplest form first; depth appears only when it applies. |
| **Agent-accessible** | Dobbie can invoke it, and mentions it without being asked. |

**Progressive is a constraint on Discoverable, not a licence to hide.** It means
ordering by relevance, never burying a capability behind a menu: a thread with
no meeting offers *Schedule Meeting*; a thread that has one offers *Reschedule*
instead. Both are one click. What a user never sees is the full catalogue of
everything the product can do.

This exists because of a real failure. Thread↔meeting links shipped working —
the data was correct, the tests passed, the assistant could use it — and the
feature was effectively absent, because nothing rendered it and the only entry
point was an unlabelled calendar icon. It scored **Implemented** and nothing
else.

### Corollaries that keep being relearned

- **No silent fallbacks on drift.** When state has changed underneath us — a
  linked record deleted externally, an ambiguous target, a missing prerequisite
  — surface it. Never quietly degrade to a default action. In mail and calendar
  work the fallback is outward-facing: silently recreating a deleted meeting
  fires a second invite at every attendee.
- **Ambiguity is asked, never guessed.** Two contacts with the same name, two
  meetings on one thread, a name that resolves to nothing.
- **Scheduling is deterministic wherever it can be.** The model decides *intent*
  and writes the *communication*. Availability, ranking, precedence and
  preference evaluation are computed in code — a testable function beats
  behaviour nobody can reproduce.
- **Source of truth, in order:** calendar (what is committed) → stored
  preferences → the workflow's suggestion → generated text. Prose that
  contradicts the calendar is a bug in the prose.
