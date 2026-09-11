# How a wiki page is built

Every page in this wiki has the same six parts, in the same order. That is not tidiness for its own
sake — each part answers a question a reader arrives with, and a page that skips one sends them back
out to guess.

## The skeleton

```markdown
# <Subject>

<Two to four sentences: what this page covers, and what you will be able to do after it.
 Say plainly what is NOT on this page and where that lives.>

## On this page
<A bulleted index of the page's own headings, as anchor links. Every page has one, even short
 ones — it is how a reader decides whether to keep reading.>

## How it works
<The mechanism, honestly. What the toolkit actually does when you use this; where the seam is;
 what it cannot do. A reader who understands the mechanism can debug a case this page never
 anticipated, and a reader who only has steps cannot.>

## Walkthrough
<One concrete thing, start to finish, with real commands and real filenames. Not a survey of
 options — one path that works, with the alternatives named at the end.>

## An agent session
<What working on this with an agent actually looks like: what you say, what it calls, what comes
 back, where you step in. Written as an abridged transcript, not as a claim about capability.>

## Things to keep in mind
<The traps. Each one is something that actually cost someone time, said as the symptom first
 ("your check passes and the feature is off") and the cause second. No speculative warnings —
 if it has never bitten anyone, leave it out.>

## Where to go next
<Two lists: other wiki pages, and the reference documents with the section to read.>
```

## The rules behind it

**The wiki does not own facts the manuals own.** Tool parameters, exact tables, version numbers,
the full list of anything — link, do not copy. A copied table is wrong within two releases and
nobody notices. When a walkthrough genuinely needs a parameter, use it in the example and link the
reference beside it.

**Every page opens with its own index.** A reader landing from a search needs to know in five
seconds whether this is their page. The index does that; a paragraph does not.

**Show the mechanism before the steps.** This is the single thing that separates this wiki from a
tutorial blog. Steps go stale and cover one case; the mechanism covers the case you have.

**The agent section is a transcript, not a promise.** Show the actual shape — including the turn
where the agent got it wrong and the check caught it, when that is what really happens. A section
that reads like marketing teaches nothing and ages badly.

**Traps are earned.** "Things to keep in mind" is a list of scars. If it has not bitten anyone, it
is not on the list. Where a trap was measured rather than guessed, say the number.

**Symptom first.** A reader searching for a trap searches for what they are seeing, not for what is
wrong. Write "your probe is green and the code is not loaded" before "the second JVM cannot bind the
port".

**Write for someone who is not using an agent too.** Much of the toolkit is useful from a plain
session with a person typing. Mark the parts that genuinely need an agent; do not assume one.

## Reference pages are the one exception

`README.md` (the map), `glossary.md` and `troubleshooting.md` carry an index and a "where to go next"
and nothing else from the skeleton — no walkthrough, no agent session, no traps list. That is
deliberate, not an oversight: a glossary with a tutorial in it is a worse glossary, and
troubleshooting **is** the traps list, organised by symptom instead of by subject. Do not "finish"
them.

Every other page has all six parts. The mechanism section may take a subject-specific title — "The
log channel", "The arithmetic", "Which tools answer without a client" — as long as it comes before
the steps and explains the machinery rather than the procedure.

## Tone

Plain, specific, unhurried. Say the limit out loud rather than routing around it — a modder who
meets a stated absence trusts the rest of the page, and a modder who discovers an unstated one does
not. No exclamation marks, no "simply", no "just".
