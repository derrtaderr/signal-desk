---
name: signal-desk sender adapter contract
read_by: anyone adding or replacing a handoff adapter, test/adapter-conformance.test.mjs which enforces it, and the reviewer grading lane/signal-desk-m2
date: 2026-09-13
status: contract, M2
parent: docs/DESIGN.md §"Send boundary"
---

# The sender adapter contract

The design ends the pipeline at an approval queue, and says survivors "export through a
pluggable sender interface with one reference adapter". This is that interface.

## The rule that comes before the contract

**Nothing in this repo sends anything.** An adapter *renders*. The handoff stage returns what
was rendered, and the CLI writes it to a file. There is no transport here, and there is not
going to be one: SMTP, HeyReach and every other real sender are non-scope in the open tool, in
every milestone.

This is not a limitation waiting to be lifted. It is the reason the tool is safe to point at a
real list before anyone trusts it.

## The shape

```js
{
  name:       string,   // equal to its key in the registry
  extension:  string,   // the file extension its serialised form takes
  render(lead, ctx) -> artifact,   // pure, deterministic, no I/O
  serialize(artifact) -> string,   // the bytes the CLI writes
}
```

Register it in `src/adapters.mjs` and select it with `config.handoff.adapter`. That is the whole
extension mechanism, and it is the same answer the stage contract gives: replace a module, edit
the wiring. There is no plugin framework.

## What conformance means

`test/adapter-conformance.test.mjs` applies one harness to **every** adapter in the registry, so
a third one added tomorrow is covered the moment it is registered rather than whenever someone
remembers to write tests for it. Each of these is asserted for each adapter:

| Requirement | Why |
|---|---|
| Declares `name`, `extension`, `render`, `serialize` | The contract is checked, not assumed |
| `name` equals its registry key | A refusal names the adapter the config asked for |
| `render` returns a plain object | It has to be inspectable and serialisable |
| `serialize` returns a string ending in a newline | Files end in newlines |
| Rendering twice produces identical bytes | Replay compares exports between runs |
| `render` does not mutate the lead | A later stage must see what earlier stages wrote |
| The artifact is `dry_run: true` and never `sent: true` | The tool does not send |
| The artifact carries `draft_hash` | The export is bound to the message a human approved |
| The artifact carries `approved_by` | An export is attributable to a person |
| `render` works with a context whose `fetch` throws | Structural proof it performs no I/O |
| No `send`, `transmit`, `deliver`, `post` or `dispatch` method | Keeps a future adapter honest |

## Purity, and why it is checked the way it is

`render` gets the injected `ctx`, the same one stages get, and is expected to use it only for
values like `run_id`. The conformance harness hands every adapter a context whose `fetch`
throws on any call and asserts rendering still succeeds. That is a structural proof rather than
a reading of the source, and it is the kind that survives someone editing the source later.

No adapter may read the wall clock. The `eml` adapter deliberately writes **no `Date` header**
for exactly this reason: a wall-clock stamp would make two identical runs produce different
bytes and break replay, for a field nothing here reads.

## Export naming

```
runs/<run-id>/handoffs/<lead-id>-<draft-hash>.<extension>
```

Three separations, each doing a job:

- **Run scoping** keeps one run's exports away from another's.
- **The lead id** says who the message is to.
- **The draft hash** separates two *different messages* to one person. Without it, a second
  draft for the same lead would overwrite the first, which is precisely the data loss the M1
  review found.

The CLI's writer refuses a path that already exists with **different** bytes, and says what it
is protecting. Identical bytes are not a collision; they are an idempotent re-run, which is what
keeps `signal-desk run` safe to invoke twice into the same directory.

## The adapters that ship

| Name | Extension | What it renders |
|---|---|---|
| `dry-run-json` | `json` | Every fact the pipeline decided, in one readable object. The reference implementation. |
| `eml` | `eml` | RFC-5322-shaped headers and body. A file, not a transmission. |

The `eml` adapter writes `X-Signal-Desk-Dry-Run: true` into its own headers, so a message that
somehow escaped this repo would still announce what it is.

## Adding one

1. Write it in `src/adapters.mjs` against the shape above.
2. Register it under a key equal to its `name`.
3. Run `npm test`. The conformance harness already covers it.
4. Select it with `config.handoff.adapter`.

If the adapter you are reaching for is a transport, stop. That belongs in your own repo,
downstream of the artifacts this one writes.
