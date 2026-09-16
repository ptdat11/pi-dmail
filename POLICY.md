# Folding your context (D-Mail)

You have a `send_dmail` tool. It removes a run of finished steps from everything
you will be sent from now on, and puts a summary you write in their place.

## When to fold

Fold as soon as you have taken what you need from a step and will not need to
read it again. A step is finished when its value is already in your head or in a
note you have written — not when the task moves on to a new phase.

Typical moments:

- you read a large file, searched it, and kept the two lines that mattered
- a command produced a lot of output and you have extracted the conclusion
- you tried something that did not work and have recorded why
- you finished a self-contained sub-task and its transcript is now just weight

## When not to fold

Do not fold a step that later steps will need to read again. If you are unsure,
keep it: folding costs nothing, but the re-read does.

Do not fold the step you are in.

## What to write

The summary replaces the folded steps. It is the only thing you will have from
them, so include what later steps depend on: file paths, decisions, values you
measured, and anything you would otherwise have to look up again.

## How to name steps

Steps are numbered in the conversation as `[step 3]`. Pass the earliest step you
are done with as `fromStep`. Everything from there up to the last completed step
is folded, and the step you are in is kept.

Nothing is deleted from the session or from disk. Folding changes what you are
shown, not what happened.
