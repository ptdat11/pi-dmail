# REQUIRE: Folding your context (D-Mail)

You have a `send_dmail` tool. It removes a run of finished steps from everything
you will be sent from now on, and puts a summary you write in their place.

Folding is the primary way your context stays small — compaction is only the
backstop, and it cuts by recency, not by usefulness. Fold a run as its task ends.
Folding earlier in a run is allowed and sometimes right — but it is provisional,
and the closing fold absorbs it.

## The unit: a finished action

The thing you fold is a **finished action**: the smallest piece of work that has
a conclusion of its own. "Ran the venue tests", "read the manifest", "searched
for the callers of `resolve`" are actions. An action may span more than one tool
call. When several actions share one conclusion, fold them as one run.

## Fold timing

Fold an observation when you can state its conclusion, carrying the facts you
have now and that conclusion. If you cannot conclude yet, say so — `cause
unknown` is a valid conclusion, and it is a fact about what you know. When the
answer arrives later, fold that as its own action. Do not wait until you know
everything to fold anything.

**Fold when a task completes.** A task — a ticket, a question, a review round —
closed end to end is the strongest cut point: nothing that follows will change
what its summary says. A summary written at a task boundary stays true for every
request that comes after, and that is what lets this one rule generalize to the
folds below you: past task folds need no revisiting — each one closed a task
that is still closed. When a task completes, fold its whole run as one, including
the steps you already folded inside that run — one summary replaces the memos it
absorbs.

A task ends where its result is: a merged commit, a shipped fix, an answered
question, a signed-off review, a ticket closed. A subagent's report is not a task
end — it is already a summary. A failing test is not a task either; it is a step
inside the task that fixes it.

Folding inside a run is a pressure valve, not a rule to observe. Fold early when
you are carrying more than you can hold, and treat that fold as provisional: it
exists to protect the rest of the run, and the closing fold will overwrite it.
You must fold mid-run anyway when five steps have passed since the last fold, or
when one step produced a very large stretch of transcript.

The closing fold starts where the run starts, not where its last provisional fold
started. A fold starting inside a summary it does not reach back to leaves the old
memo standing beside a new one, so the tool refuses it: if the run's first step
is already folded, climb to the marker of the summary that covers it — the
`[step N]` you can see above that memo — and fold from there, absorbing it.

The one summary you write at the end carries the whole run forward, so write it
for the session, not for the transcript: keep what work outside this task will
depend on, and drop the mechanics that only mattered inside it. An absorbed memo
is gone — nothing in the session can show it again — so anything later steps need
must be in the new summary.

**Preview before you commit.** The fold tool's `preview` parameter shows exactly
what a fold would hide without hiding anything. Use it when a fold looks large
or when you are deciding where to cut.

## Actions you must fold

Mandatory fold points. When one of these finishes, write the summary and fold it
before your next tool call — or before you answer the user, if that was the last
command:

- `test-run` — you ran a test suite or a test file.
- `build` — you ran a type check, build, lint, or formatter.
- `failure` — a command errored or a test failed. Needing the error text to fix
  it is not a reason to keep the run: the bounded error in the summary is what
  makes folding it safe.
- `digested-read` — you read a file (or part of one) and took what you needed. A
  read you discarded is still a `digested-read` (conclusion: not relevant).
- `concluded-search` — you searched or grepped and drew the conclusion. A search
  with no hits is still a `concluded-search` (conclusion: no matches).

If a mandatory action cannot be summarised yet, fold it anyway and write what you
do not know under `open`.

Everything else — an edit, a git command, an install, a subagent's report — is a
judgement call: fold it if you can state its conclusion and will not act on its
raw output again.

Inside a run these are guidance, not debt: fold one when you need the room. The
two that are never optional are a `failure` — you will need the error text again
to fix it — and a run of five steps or one very large step with nothing folded
since. At the end of the run, the fold that matters is the one that closes the
task.

## In a verify loop

When you expect to re-run a command after a fix, the earlier run's conclusion is
only final once the newer one answers it ("fixed N, introduced M"). Two cases:

- **The earlier run is still shown:** fold **from the earlier run's step**. That
  call carries every step from there up to the step before the one you are in —
  including the fix — so give the fix's changes and the newer run their own
  blocks in the summary. Fold from the run's step, not the fix's, so the failing
  run leaves the context too.
- **The earlier run was already folded on arrival** (as a `failure`): that fold
  already documents it. Fold the fix and the newer run instead.

## What to write

The summary is all that will remain of the folded steps. Use these fields:

- `commands` — the exact commands, so the action can be re-run, not re-derived.
- `outcome` — what happened, with the numbers the command itself reported
  (pass/fail counts, duration, exit status).
- `paths` — every file the action read, changed, or produced.
- `decisions` — a decision you made and why it won that way. Only when there was one.
- `open` — questions the action left unanswered. Write `open: none` when there are none.

If a fold covers more than one action, give each its own block under all the
fields.

A `failure` additionally carries:

- `failure` — exit status, the exact reproducer command, the failing path, the
  error verbatim (the error line plus the frames that name our own code, about 20
  lines), what you tried, and your current hypothesis. `hypothesis: unknown` is
  allowed and worth writing.

Do not write token counts or dollar cost: those are per-turn, not per-action.
Line or byte volume is allowed but optional.

## When you are unsure

Fold if you can write the exact command that produces the observation again;
otherwise keep. A recorded reproducer turns a re-read into a re-run, so folding
too much is bounded.

Do not fold the step you are in.

## How to name steps

Steps are numbered in the conversation as `[step 3]` — one per message turn, the
user's and yours. Pass the earliest step you are done with as `fromStep`. Everything
from there through `throughStep` (default: the last completed step) is folded, and
the step you are in is kept. Pass
`throughStep` explicitly, inclusive, when a later step is still worth keeping raw.

Steps you folded keep their numbers, so the markers can jump (`[step 4]` then
`[step 12]`) — read the markers, do not count. Folding from a step always carries
every step in between; if you missed one, give it its own block. A step you
already folded can be folded again — that is how a task's closing fold absorbs the
memos written inside it.

Because a request is a step like any other, the user's own message can go too:
name the request's step as `fromStep` to fold it with the answer it produced, or
stop there with `throughStep` to keep a request whose answer is still worth reading
raw.

Nothing is deleted from the session or from disk. Folding changes what you are
shown, not what happened.

## Worked example

A passing test run — `8 passed in 0.73s`:

```
commands: PYTHONPATH=src pytest tests/infrastructure/test_venue_registry.py -q
outcome:  8 passed, 0 failed, 0 deselected; 0.73s; exit 0
paths:    tests/infrastructure/test_venue_registry.py
open:     none
```

Two actions sharing one conclusion — "the seam holds":

```
- commands: PYTHONPATH=src pytest tests/infrastructure/test_venue_registry.py -q
  outcome:  8 passed; 0.73s; exit 0
  paths:    tests/infrastructure/test_venue_registry.py
  open:     none
- commands: PYTHONPATH=src pytest tests/api/test_main_lifespan.py -q -k venue_seam
  outcome:  1 passed; 1.71s; exit 0
  paths:    tests/api/test_main_lifespan.py
  open:     none
```

A failure — `5 passed, 1 failed in 3.92s`, `test_x` failing:

```
commands:   PYTHONPATH=src pytest tests/api/test_main_lifespan.py -q
outcome:    5 passed, 1 failed; 3.92s; exit 1
paths:      tests/api/test_main_lifespan.py
failure:    exit 1; reproducer: PYTHONPATH=src pytest tests/api/test_main_lifespan.py -q;
            tests/api/test_main_lifespan.py::test_x AssertionError: expected 2 == 3
            (traceback trimmed to our frames); tried: re-ran test_x alone — same failure;
            hypothesis: unknown
open:       whether the spec ordering changed
```
