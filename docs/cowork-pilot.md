# Cowork capture pilot

These commands implement two opt-in capture transports. A real Cowork pilot is
still required before treating either as supported. Fixture tests prove the
translation, consent gates and delivery behavior; they do not prove Cowork hook
dispatch, its installed paths or the contents of its actual export.

## Consent and routing

Use a disposable project with synthetic activity. Run the connect skill in the
runtime that will send its records, sign in if needed, and explicitly select the
complete non-empty Workspace set. Each selected Workspace receives the same full
record; the audience is everyone with access to any of them. Raw records are
structurally sanitized, not secret-scrubbed. Automatic recall is a separate choice.

Native capture retains this checkout's document-consent boundary: supplied text
documents and supported PDF references are captured only after its recorded
attachment consent, with the attachment kill switch still applying. PDF bytes
are not secret-scrubbed. OTLP consumes only exported content; file paths in an
event never cause this relay to open or fetch a document.

Then confirm the Cowork engine `session.id` and explicitly bind it to this one
project and one transport. A task title, the desktop's task URL and an attached
host path do not establish that identity. No organization, email, source user ID
or attached path in OTLP selects an Augenta route. The project must be joined here
using this person's own active Connectors. A native binding also pins the exact
accessible transcript file. A machine-local claim prevents another project or
transport on this relay from claiming the same engine session.

Changing the sign-in, join, Workspace set or gateway invalidates the binding.
Start a new task and bind it after joining again. Deleting the project config or
setting `AUGENTA_CAPTURE_ENABLED=0` stops both transports. The task registry and
pending events are private checkout state, excluded by `.augenta/.gitignore`.
OAuth credentials remain in the machine-local auth file; CLI results contain
counts and diagnostic codes only.

## First collect read-only runtime facts

For one local and one cloud task, record the desktop version, task URL and engine
session ID separately. In the task's actual shell, collect:

- `pwd`, the confirmed project mount and the absolute skill directory supplied by
  the harness. Check that the matching `dist/scripts/connect.mjs` exists on the
  same runtime as the project; stop when the device and cloud shells split them.
- Whether native hooks actually fire, their event names, payload keys, `cwd`,
  session ID and transcript path. Record an absent hook as an observation.
- Transcript availability, file size and event types, without copying private
  message text into the diagnostic report.
- Only known environment markers (`CLAUDE_CODE_REMOTE`, `CODEX_HOME`,
  `AUGENTA_EPHEMERAL`), whether HTTP/HTTPS proxy and `NO_PROXY` variables are set,
  their hostnames without credentials, and whether the proxy CA paths exist.
  Do not dump the environment, auth files or proxy headers.
- For OTLP, the actual resource service name, event names, attribute keys and
  types, `session.id`, `prompt.id`, `event.sequence`, content redaction and size
  markers. Use a synthetic prompt and response to inspect content safely.

An environment heuristic or the presence of a cached plugin is not proof of
native capture. Ordinary Code and Codex sessions retain their existing behavior.

## Native transcript transport

Resolve both bundles from the plugin version whose skill directory was supplied.
The following placeholders must be replaced with confirmed absolute paths and
the engine session ID:

```bash
node /plugin/dist/scripts/connect.mjs --json --project /project \
  --cowork-task engine-session-id --cowork-transport native \
  --cowork-transcript /runtime/transcript.jsonl
```

Binding begins at the current transcript end; older task content is not imported.
Feed actual hook frames to the bridge, including `UserPromptSubmit` before the
corresponding turn and `Stop` after it:

```bash
node /plugin/dist/capture/capture.mjs --cowork-native --project /project \
  < /runtime/confirmed-hook-payload.json
```

The bridge reuses the normalizer, turn cursor, capture cursor, outbox and shipper.
It refuses an unbound engine session or a different transcript. Where the real
harness dispatches the existing plugin hooks, configure
`AUGENTA_COWORK_NATIVE=1` specifically for that Cowork runtime: capture and
automatic recall then require a valid task binding. This is an explicit operator
setting, not an inferred Cowork environment marker. Do not claim native pilot
success from manually constructed hook frames; verify actual dispatch and the
saved Experiences after a completed Cowork turn.

## OTLP transport

Run the relay on a customer-controlled machine with the project and its own
sign-in and checkout links. Bind the confirmed engine session:

```bash
node /plugin/dist/scripts/connect.mjs --json --project /project \
  --cowork-task engine-session-id --cowork-transport otlp
node /plugin/dist/capture/capture.mjs --cowork-listen 4318 --project /project
```

The operator privately sets `AUGENTA_COWORK_COLLECTOR_TOKEN` to a random secret
of at least 32 characters before starting the listener. Never put it in an agent
prompt or CLI argument. The listener binds only `127.0.0.1`; expose it through an
authenticated HTTPS reverse proxy under the customer's control. Cowork cloud
cannot reach the device's localhost. Use the same private bearer header in the
collector configuration, without using an Augenta token as the collector secret.
An existing collector can also pipe one HTTP/JSON logs request to:

```bash
node /plugin/dist/capture/capture.mjs --cowork-otlp --project /project \
  < /collector/synthetic-logs.json
```

The receiver accepts `POST /v1/logs`, `application/json`, without compression,
up to 4 MiB. Select `http/json`; protobuf and gRPC are not implemented. It ignores
metrics and traces. Multiple `--project` arguments register eligible projects;
each task still needs its explicit binding to exactly one of them. Authentication
is checked before reading request content. Unbound, unconnected, disabled and
pre-binding tasks are filtered before content enters Augenta's outbox. The
customer's collector may receive an organization-wide stream, so configure its
retention accordingly; this implementation does not enable that export itself.

For the pilot, an administrator enables prompts, assistant responses and tool
details at the customer-controlled OTLP endpoint. The relevant setting is:

```json
{"otlpContentCapture":["userPrompts","assistantResponses","toolDetails"]}
```

Verify the actual exported content, then start a new task after configuration
changes. Metadata-only exports are not sufficient. Do not enable organization-wide
content export without the organization's explicit decision.

## Mapping and source limits

The current [Cowork monitoring reference](https://claude.com/docs/cowork/monitoring)
documents prompt correlation and per-session sequence numbers. The translator
maps a prompt to an agent turn, preserving exported sequence numbers; it queues
late events until their prompt arrives, deduplicates identical events and refuses
conflicting sequence reuse. It does not invent a turn-completion event. Later
batches can produce another chunk of the same turn, as interrupted native drains
already do. Each chunk uses the existing `type: trajectory`, `src: claude-code`,
`sid`, `proj`, `events` and `data` envelope and `/v1/experiences` path.

Prompts and response text become message steps, tool results become tool steps,
and request usage, errors and decisions remain correlated steps. Normalized text
is scrubbed using the existing rules; the raw OTLP record receives structural
sanitation. Automatic-recall context is excluded from forwarding. Missing content
is marked rather than fabricated. Thinking is unavailable; response text and tool
arguments are bounded by the exporter. Complete tool-result bodies are not
documented in the Cowork event schema. The separate
[third-party desktop reference](https://claude.com/docs/third-party/claude-desktop/telemetry)
lists tool-output and raw-body options; this pilot does not assume undocumented
fields exist in the first-party Cowork stream.

The local task buffer has limits of 10,000 accepted event sequences and 1 MiB of
events waiting for a prompt. Reaching a limit refuses a batch without committing
it. A transactional append journal keeps source deduplication and the outbox in
agreement across interrupted writes. A damaged journal or task state stops
capture rather than resetting and replaying history. API delivery keeps the
existing destination cursors, retries, fan-out and retention limits.

## Acceptance record

For each transport, save the actual runtime facts above, the synthetic pilot
marker, task-to-project binding, selected Workspace names and Connectors, and
the completed turn's session, turn and sequence range. Check local health and
verify the saved Experience and its processing result in **every** selected
Workspace. API acceptance alone does not establish ingestion or extraction.
Repeat with a duplicate batch, out-of-order delivery, a temporarily failing
destination, disabled capture, a missing join and an inaccessible Connector.
Confirm unbound tasks never reach Augenta and that choosing OTLP suppresses native
capture of the same confirmed engine session.

The implementation remains a pilot until those real Cowork checks pass. Native
hook availability, cloud environment markers, exporter event shape and transport
session-ID equality must be observed directly before promoting it.
