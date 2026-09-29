# D-Mail

**Model-driven context folding for [pi](https://github.com/earendil-works/pi-coding-agent).**
The agent folds its own finished steps away and replaces them with a summary it writes.

![D-Mail folding, side by side: left is what the model is sent once fold records are replayed, right is
the session as stored](docs/visuallization.gif)

*Both panes are the same conversation. On the left, a fold collapses a finished range into one summary
chip, so the sent context stays lean. On the right, the stored transcript keeps every step and never
shrinks — which is why folding too much costs a re-read, not data.*

## The problem

Long conversations get compacted when they hit a size threshold. Compaction cuts by recency, never by
usefulness, so dead weight competes for space with material that matters. The model is the one thing in
the loop that actually knows which steps it is done with — and pi gave it no way to say so.

## How it works

D-Mail adds one tool, `send_dmail(fromStep, summary)`. The agent sees a `[step N]` marker before each
assistant turn, and calling the tool records that everything from `fromStep` up to the last *completed*
step is finished with, and that `summary` replaces it. A `context` hook replays those records on every
request, so the agent is sent the summary instead of the transcript.

The step the agent is currently in is never folded, so it passes the earliest step it is done with, not
the current one. The end of the range is resolved once, at call time, and frozen: a fold cannot quietly
swallow every step that follows it. Numbers come from the branch, so a step keeps its number even after
it is folded away — but markers are only emitted for steps still in view.

The idea is borrowed from Moonshot AI's
[Kimi CLI](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/tools/dmail/dmail.md), whose
`SendDMail` tool folds finished messages out of its own context into a self-written summary. Ours folds
a range of steps; theirs rewinds to a checkpoint.

## Install

```bash
# permanent
pi install git:github.com/ptdat11/pi-dmail

# or try it without installing
pi -e git:github.com/ptdat11/pi-dmail
```

Then run `/reload` in pi, or restart it. Managed installs can be inspected and undone with `pi list`,
`pi update git:github.com/ptdat11/pi-dmail`, and `pi remove git:github.com/ptdat11/pi-dmail`.

> **Forking?** A git package clones the **repository root** as the extension directory, and there is no
> subdirectory support. `index.ts` must stay at the top level, alongside `fold.ts`, `profile.ts`, and
> `POLICY.md`.

## Using it

You rarely invoke D-Mail directly — the agent calls `send_dmail` when it decides a stretch of transcript
is finished. What you get is a status badge and two commands:

| Surface | What it does |
| --- | --- |
| Blue `D-MAIL ON` / red `⚠ D-MAIL OFF` badge | Whether folding is active, shown in the footer. |
| `/dmail` | Toggle folding for the session. Also `/dmail on`, `/dmail off`, `/dmail status`. |
| `/send-dmail` | Ask the agent to fold right now, from the earliest step still in view. Refused when folding is off or `send_dmail` isn't an active tool. |
| `--dmail-disabled` | Force folding off for one session, overriding settings (`/dmail` turns it back on). |
| `dmail.enabled` in `settings.json` | Default mode for new sessions (`false` starts them off). |


Turning folding off is a real escape hatch, not a cosmetic switch. The tool is withdrawn, the agent's
folding instructions are withheld, and fold records stop being applied — so anything folded earlier comes
back into context as the raw transcript. Reach for it if a summary turns out to have dropped something.

### Choosing the default mode

New sessions start with folding **on**. To start them off, set the one key D-Mail owns in
`~/.pi/agent/settings.json` (global) or `<project>/.pi/settings.json` (per project):

```json
{
  "dmail": {
    "enabled": false
  }
}
```

Project settings override global ones. Anything else — key absent, unparseable JSON, or a non-boolean
value — means on. `--dmail-disabled` overrides both, and `/dmail` overrides everything for the current
session. The `/dmail` toggle is deliberately session-local; only the starting mode is read from settings.

## Why it's safe to let a model decide

Three properties, stated plainly, because they are what make this safe:

- **Non-destructive.** Folding changes what is *sent*, never what is stored. Session entries and files
  are untouched, so folding too much costs a re-read, not data.
- **Uncached.** There is no fold state to lose. Records live in the session and are replayed from it, so
  folding survives `--resume` and survives `/reload` mid-session. Only the starting mode comes from
  settings; a new session starts from `dmail.enabled`, which defaults to on.
- **Bounded damage.** A fold that no longer resolves is skipped, not applied partially. And a fold can
  never separate an assistant message from the tool results that answer it — that is a hard provider
  error, so `fold.ts` refuses any range that would cause it.

Folding also stays out of pi's way: records are read from the active branch, then split by the current
view's compaction boundary. A fold on an abandoned branch, or written before the boundary of the last
compaction, is never replayed — and it is counted, not erased: the fold result reports
`folds skipped: N` whenever N is greater than zero, so a skip is always explainable. The records
themselves are never rewritten.

## Measuring the effect

`profile.ts` is an offline profiler. It replays one session and, for every request actually made,
compares what the provider charged against what the context would have cost with and without folding.

```bash
node profile.ts <session> [--last N] [--json] [--csv]
node profile.ts --list [query] [--all] [--deep] [--json]

# via npm — note the `--`, otherwise npm eats the arguments
npm run profile -- 01a0a7b8 --csv
```

`<session>` is a `.jsonl` path, a path relative to the sessions root, or any unambiguous id prefix
(`01a0a7b8`). `--list` lists sessions for the current directory, `--all` widens that to every project
under the sessions root, and `--deep` also counts their requests, folds, and prompt tokens.

Prompt size and cache split are *measured* from the persisted `usage` of each assistant message. The
folded and raw message lists are *reconstructed* with the same `foldContext` the extension uses, so their
difference is the genuine effect of folding. The absolute estimate is a characters/4 heuristic that
ignores the system prompt and tool schemas — trust the folded-vs-raw delta, and treat `overhead` as a
drift check. `$saved` values folded-away tokens at rates derived from the session's own usage/cost pairs
(no price table), as a range rather than a point, since the raw counterfactual's cache behaviour is not
observable. Output spend is unaffected, so prompt-side spend is printed as the ceiling on any saving.

## Notes

- The agent's folding policy lives in `POLICY.md` and is appended to the system prompt. Point `DMAIL_POLICY`
  at a different file to use your own; if the file is missing, a short built-in fallback keeps the tool
  discoverable.
- `send_dmail` refuses a step that has already been folded out of view, and refuses the step the agent is
  currently in — there is nothing finished to fold yet.
- Tests: `npm test` runs node's built-in runner over every `test/**/*.test.ts` — the fold algebra
  (including the era split that counts orphaned records), the replay/refold wiring, the result renderer,
  orphan-visibility acceptance, the harness smoke tests, the profiler, and the `settings.json` default-mode
  reader.

## License

MIT — see [LICENSE](LICENSE).
