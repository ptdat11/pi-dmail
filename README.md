# D-Mail (pi extension)

D-Mail lets the agent fold its own finished context away.

Long conversations get compacted when they hit a size threshold, and compaction cuts by recency —
never by usefulness — so genuinely dead weight competes for space with the material that matters.
The model is the one thing in the loop that actually knows which steps it is done with, and pi gave
it no way to say so.

D-Mail is one tool that closes that gap. `send_dmail(fromStep, summary)` records that everything from
`fromStep` up to the last completed step is finished with, and that `summary` replaces it. A `context`
hook replays those records on every request, so the agent is sent the summary instead of the transcript.

The idea is borrowed from Moonshot AI's
[Kimi CLI](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/tools/dmail/dmail.md), whose
`SendDMail` tool folds finished messages out of its own context into a single self-written summary. Ours
folds a range of steps; theirs rewinds to a checkpoint.

![D-Mail folding, side by side: left is what the model is sent once fold records are replayed, right is
the session as stored](docs/visuallization.gif)

*Both panes are the same conversation. On the left, a fold collapses a finished range into one summary
chip, so the sent context stays lean. On the right, the stored transcript keeps every step and never
shrinks — which is why folding too much costs a re-read, not data.*

## How it works

Steps are numbered. Conversations are shown to the agent with a `[step N]` marker before each assistant
turn. Numbers come from the branch, so a step keeps its number even after it has been folded away — but
markers are only emitted for steps still in view.

`send_dmail(fromStep, summary)` folds from `fromStep` through the last *completed* step. The step the
agent is currently in is never folded, so it passes the earliest step it is done with, not the current
one. The end of the range is resolved once, at call time, and frozen: a fold cannot quietly swallow every
step that follows it.

## Using it

You rarely invoke D-Mail directly — the agent calls `send_dmail` when it decides a stretch of transcript
is finished. What you get is a status badge in the footer and two commands:

- A blue **`D-MAIL ON`** badge when folding is active, a red **`⚠ D-MAIL OFF`** when it isn't.
- `/dmail` — toggle folding for the session. Also accepts `/dmail on`, `/dmail off`, `/dmail status`.
- `/send-dmail` — ask the agent to fold right now. The agent starts at the earliest step still in view and folds
  through the last completed step. Refused when folding is off or when `send_dmail` is not an active tool.
- `--dmail-disabled` — force folding off for one session, overriding settings (`/dmail` turns it back on).
- `dmail.enabled` in `settings.json` — the default mode for new sessions (`false` starts them off).

Turning it off is a real escape hatch, not a cosmetic switch: the tool is withdrawn, the agent's folding
instructions are withheld, and fold records stop being applied — so anything folded earlier comes back
into context as the raw transcript. That is what to reach for if a summary turns out to have dropped
something.

### Choosing the default mode

New sessions start with folding **on**. To start them off instead, set the one key D-Mail owns in
`~/.pi/agent/settings.json` (global) or `<project>/.pi/settings.json` (per project):

```json
{
  "dmail": {
    "enabled": false
  }
}
```

Project settings override global ones. Anything else — the key absent, unparseable JSON, or a
non-boolean value — means on. `--dmail-disabled` overrides both, and `/dmail` overrides everything for
the current session.

The `/dmail` toggle stays deliberately session-local: it does not outlive the session that asked for
it. Only the starting mode is read from settings.

## Why it's safe to let a model decide

Three properties, stated plainly, because they are what make this safe:

**Non-destructive.** Folding changes what is *sent*, never what is stored. Session entries and files are
untouched, so folding too much costs a re-read, not data.

**Uncached.** There is no fold state to lose. Records live in the session and are replayed from it, so
folding survives `--resume` and survives `/reload` mid-session. The `/dmail` toggle is not persisted;
a new session starts from the `dmail.enabled` setting, which defaults to on.

**Bounded damage.** A fold that no longer resolves is skipped, not applied partially. And a fold can
never separate an assistant message from the tool results that answer it — that is a hard provider error,
so `fold.ts` refuses any range that would cause it.

Folding also stays out of pi's way: records are read from the active branch of the current view, so folds
on an abandoned branch, or on the far side of a compaction boundary, are invisible rather than wrongly
replayed.

## Measuring the effect

`profile.ts` is an offline profiler. It reads one session file and, for every request that was actually
made, reports what the provider charged you next to what the context would have been with and without
folding.

```bash
node profile.ts <session> [--last N] [--json] [--csv]
node profile.ts --list [query] [--all] [--deep] [--json]

# via npm — note the `--`, otherwise npm eats the arguments
npm run profile -- 01a0a7b8 --csv
```

`<session>` accepts a path to a `.jsonl` file, a path relative to the sessions root, or any unambiguous
session id prefix (`01a0a7b8`). `--list` lists sessions for the current directory, `--all` widens that to
every project under the sessions root, and `--deep` also counts their requests, folds and prompt tokens.

Prompt size and cache split are *measured* — they come straight from the persisted `usage` of each
assistant message. The folded and raw message lists are *reconstructed* with the same `foldContext` the
extension itself uses, so the difference between them is the genuine effect of folding. The absolute
estimate is a characters/4 heuristic and does not model the system prompt or tool schemas, so trust the
folded-vs-raw delta and treat `overhead` as a drift check. It should not wander much across requests.

Provider cost comes from the persisted `usage.cost`, and the `$saved` column values the folded-away
(`saved`) tokens at marginal rates derived from the same session's own usage/cost pairs — no price table
is needed. The saving is a range, not a point, because the raw counterfactual's cache behaviour cannot be
observed: the low end charges the extra tokens as a cached prefix, the high end at the session's blended
prompt rate. Output spend is unaffected by folding, so the summary also prints prompt-side spend as the
ceiling on any saving. Sessions that never record `usage.cost` show no cost block.

The profiler runs standalone, with local ports of the helpers it needs; when
`@earendil-works/pi-coding-agent` is resolvable it uses pi's real helpers instead, which keeps the numbers
identical to pi's own context gauge.

## Install

```bash
pi install git:github.com/ptdat11/pi-dmail
```

Then run `/reload` in pi, or restart it.

To try it without installing anything permanently:

```bash
pi -e git:github.com/ptdat11/pi-dmail
```

Managed installs can be inspected and undone with `pi list`, `pi update git:github.com/ptdat11/pi-dmail`
and `pi remove git:github.com/ptdat11/pi-dmail`.

One thing worth knowing before you fork this: a git package clones the **repository root** as the
extension directory, and there is no subdirectory support. `index.ts` has to stay at the top level,
alongside `fold.ts`, `profile.ts` and `POLICY.md`.

## Notes

- The agent's folding policy lives in `POLICY.md` and is appended to the system prompt. Point `DMAIL_POLICY`
  at a different file to use your own; if the file is missing, a short built-in fallback keeps the tool
  discoverable.
- `send_dmail` refuses a step that has already been folded out of view, and refuses the step the agent is
  currently in — there is nothing finished to fold yet.
- Tests: `npm test` runs node's built-in runner over `test/profile.test.ts` and `test/settings.test.ts`
  (18 tests covering the profiler, including the fold replay math it shares with the extension, the
  cost/`$saved` derivation, and the `settings.json` default-mode reader).

## License

MIT — see [LICENSE](LICENSE).
