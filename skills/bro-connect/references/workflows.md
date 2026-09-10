# CLI workflows

Replace `/path/to/bro-connect` with this loaded skill's absolute directory and
`TAB_ID` with the ID returned by `tabs`. Examples assume the connection is saved.
Commands emit JSON; check the process exit status and response, including errors
on stderr. Use `--help` for the current command list.

## Inspect, then act

```sh
node /path/to/bro-connect/scripts/bro.mjs status
node /path/to/bro-connect/scripts/bro.mjs tabs
node /path/to/bro-connect/scripts/bro.mjs observe --tab TAB_ID
node /path/to/bro-connect/scripts/bro.mjs find "Search" --tab TAB_ID
node /path/to/bro-connect/scripts/bro.mjs screenshot --tab TAB_ID --out /tmp/bro-page.png
```

Use refs returned by the observation or selectors verified against the page.
For truncated content, continue with `read --tab TAB_ID --cursor RETURNED_CURSOR`
(or `observe` if that produced the cursor). A diff is relative to a prior
observation; use a fresh non-diff observation when a complete view is needed.

## Short batch

After verifying these example controls exist and the action is authorized, write
`/tmp/bro-actions.json` with a file-writing tool:

```json
{
  "actions": [
    { "type": "fill", "target": "input[name=search]", "text": "example" },
    { "type": "click", "target": "button[type=submit]", "timeoutMs": 5000 }
  ],
  "observe": "read"
}
```

```sh
node /path/to/bro-connect/scripts/bro.mjs actions --tab TAB_ID --file /tmp/bro-actions.json
```

The response includes `task.status`, `task.results`, `task.completedActions`, and
possibly `task.observation` or `task.error`. Confirm the resulting page state.
`fill` replaces text; `type` sends text to the focused element. Prefer these
native interaction commands over assigning DOM values in `eval`.

## Longer work and uncertain outcomes

For a known batch that can exceed 20 seconds, use a full JSON body with
`"async": true` and `"timeoutMs": 60000` beside `actions`. The task timeout is
at most 120000 ms; individual action timeouts are at most 20000 ms. Divide larger
work at meaningful verification points instead of submitting an unbounded batch.

```sh
node /path/to/bro-connect/scripts/bro.mjs task get RETURNED_JOB_ID
node /path/to/bro-connect/scripts/bro.mjs task cancel RETURNED_JOB_ID
```

Submission with `ok: true` may only mean queued. Poll `task get` with a short
bounded delay until `completed`, `failed`, or `cancelled`; avoid tight polling.
If waiting must stop, report the pending job ID or cancel it as appropriate.
After completion, read the source page to verify the outcome.

On `unknown_outcome`, inspect `taskId` (or `task.id`), completed results, and the
actual page. `cancellationRequested` only records a cancellation request; it is
not evidence of rollback. An interrupted click may already have taken effect.
Resume only the uncompleted work once its state is known; never replay the
entire batch automatically.

## End control

After the last authorized action, and before you report the remote task done:

```sh
node /path/to/bro-connect/scripts/bro.mjs release --tab TAB_ID
```

That dismisses the pointer and closes the preview. `disconnect` only removes the
local credential; it does not end control on the browser.

## Debugging scripts

Use `eval --tab TAB_ID --file /absolute/path/script.js` for page JavaScript when
normal observations/actions are insufficient. It executes in the page, not in
Node: do not assume filesystem or Node imports are available. Keep scripts
bounded and return only the necessary data. For network/console investigation,
start capture before reproducing the issue, then read the captured events.
