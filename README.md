# D-Mail

**Model-driven context folding for [pi](https://github.com/earendil-works/pi-coding-agent).**
The agent folds its own finished steps away and replaces them with a summary it writes.

![D-Mail folding, side by side: left is what the model is sent once fold records are replayed, right is
the session as stored](docs/visuallization.gif)

*Both panes are the same conversation. On the left, a fold collapses a finished range into one summary
chip, so the sent context stays lean. On the right, the stored transcript keeps every step and never
shrinks.*

## The problem

Long conversations get compacted when they hit a size threshold. Compaction cuts by recency, never by
usefulness, so dead weight competes for space with material that matters. The model is the one thing in
the loop that actually knows which steps it is done with — and pi gave it no way to say so.

## How it works

D-Mail adds one tool, `send_dmail(fromStep, summary)`. The agent sees a `[step N]` marker before each
assistant turn, and calling the tool records that everything from `fromStep` through `throughStep` (by
default, the last *completed* step) is finished with, and that `summary` replaces it. A `context` hook
replays those records on every request, so the agent is sent the summary instead of the transcript.

The step the agent is currently in is never folded, so it passes the earliest step it is done with, not
the current one. The end of the range is resolved once, at call time, and frozen — either the caller's
`throughStep` or the last completed step — so a fold cannot quietly swallow every step that follows it.
Both endpoints are step starts, which is what keeps a tool call and its result on the same side of the
cut. Numbers come from the branch, so a step keeps its number even after
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
| `/dmail` | Toggle folding for the session. Also `/dmail on`, `/dmail off`, `/dmail status`, `/dmail fold`, `/dmail price`. |
| `/dmail fold` | The user owns the cut **range**. Opens a two-phase picker over one stable, latest-first list: enter picks the **start**, enter again picks the **end** (inclusive, defaulted to the latest finished step — so Enter,Enter is the old one-cut behavior), `esc` in phase 2 returns to phase 1, `esc` in phase 1 cancels. The pending range shows as `[A - B]` with its live `~ ≈` figure in the header while the end is picked; rows older than the start are dimmed and the cursor cannot reach them. `Enter` on a folded `[a - b]` region folds the whole region in. The agent is then told the pinned range and writes the summary. Refused when folding is off, `send_dmail` isn't an active tool, or nothing is in view. |
| `/send-dmail` | Alias of `/dmail fold`: opens the picker to pin the range the agent folds (`/send-dmail 2` pins a start, `/send-dmail 2 7` the whole range, no picker needed). Refused when folding is off, `send_dmail` isn't an active tool, or nothing is in view. |
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

## Fold ladders and timing

When a fold happens is the agent's call, and it is deliberately not scripted — the mandatory folds in the
injected policy are a floor, not a schedule. Four habits shape the timing, and all four are spelled out in
`POLICY.md` so the agent states them rather than improvising them:

- **Fold large and rare, not small and frequent.** A summary replaces a finished stretch on *every*
  subsequent request, so one fold that removes a large range pays back far more than several small ones —
  and each fold moves the cut point forward, so small folds spend their savings chasing it. Fold big
  finished ranges at natural seams; let the small stuff ride until it forms one.
- **Re-fold stale ladders.** Folds stack: each one sits behind the summaries of the ones before it, and a
  long session becomes a ladder of rungs. When a rung has gone stale — superseded, contradicted by what
  came later, or already compressed once — re-fold it in place, collapsing the old summary together with
  its finished neighbours into one fresh one. Ladders are re-folded, not appended to; summaries are
  replaced, never accumulated.
- **Preview before you commit.** Every fold result carries an advisory line, and `send_dmail`'s `preview`
  parameter prints the same figures *without* folding: predicted tokens removed, predicted savings per
  request, how many requests it takes to break even, and whether the context headroom absorbs the
  summary. `/dmail price [start] [end] [summary…]` — a second number is the inclusive end — is the
  read-only command form of the same check. These numbers
  are advisory — a prediction from the session's own cache behaviour, not a promise — but they are the
  cheap way to see a cut before making it.
- **The user can pin the cut range.** `/dmail fold` (alias `/send-dmail`) opens a picker listing candidate
  cuts with their headline figures, so you choose both ends of the rung instead of waiting for the
  agent: enter sets the start, enter again sets the end, and the header prices the pending `[A - B]` while
  you move (`/send-dmail 2` or `/dmail fold 2 7` pins the range without the picker). A pinned range wins;
  the agent folds there and writes the summary.

The ladder only spans pi's current compaction window. Records written before the last compaction boundary
are skipped rather than replayed — counted, not erased (`folds skipped: N`), and the ladder restarts above
the boundary — so a ladder never spans a compact. Details under *Why it's safe* below.

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
  orphan-visibility acceptance, the harness smoke tests, the policy injection (ladder guidance present when
  on, absent when off), the profiler, and the `settings.json` default-mode reader.
- Release gate: `npm run verify:e2e` (or `make verify-e2e`) is the hand-runnable end-to-end seam
  verification — it spawns a real local `pi --mode rpc` with a keyless fixture provider, builds a session
  with a genuine fold record through the real `send_dmail` tool, forces a compact, and asserts the
  compaction summary derives from the fold summaries (folded narrative present, dropped detail absent).
  It needs no network, prints one PASS/FAIL line per assertion plus a final `RESULT: PASS|FAIL`, and is
  wired into `make release` as a release step — deliberately not into `npm test`/CI.

## License

MIT — see [LICENSE](LICENSE).
