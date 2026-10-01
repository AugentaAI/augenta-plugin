# Connection settings

Most people only need the [connect command](../README.md#connect-and-confirm).
It signs you in, asks which Workspaces should get this project's records, and
writes the settings for you.

## Change Workspaces

Run connect again. Choose the **full set** of Workspaces you want this project
to send to, including any you want to keep. The current set is marked in the
menu. You must choose at least one, even if only one is listed.

Each selected Workspace gets the same full activity, raw transcripts, and
project notes. Anyone with access to any of them may see those records.
Raw transcripts can contain secrets.

You can choose **Create a new Workspace** by itself and give it a name. The
plugin then shows a fresh menu. Creating one does not select it or connect the
project.

After saving a new set, the plugin stops sending to Workspaces you left out.
Their Connectors stay in place and idle. A **Connector** is the link that sends
this project's records to one Workspace. Changing your choices does not move
or delete records already sent.

If a Workspace fails to connect, the result names it. Only successful choices
are saved. If none succeed, or you cancel, the old settings stay in place and
the project keeps sending to its old Workspaces.

## Files on your machine

| Path | What it holds |
| --- | --- |
| `<project>/.augenta/config.json` | This project's connection settings. A browser connection's records the project's Workspaces and no Connector or sign-in, so it may be committed |
| `<project>/.augenta/.gitignore` | Keeps the rest of `.augenta/` out of Git: `*` for API-key configs, which hold the key; `*`, `!/.gitignore` and `!/config.json` for browser connections. Connect leaves a file you wrote yourself alone |
| `<project>/.augenta/state/links.json` | This checkout's own Connector in each recorded Workspace, whose sign-in made them, and when it joined. Never committed |
| `<project>/.augenta/outbox/` | Records waiting to be sent, plus delivery state |
| `<project>/.augenta/state/recall-backoff.json` | When automatic recall may ask again after Augenta asked it to slow down |
| `~/.augenta/auth.json` | Your saved sign-in, shared across connected projects |

The plugin needs a readable project config to capture or recall. A browser
connection also captures only once this machine is signed in for it and this
checkout has joined it with connect; recall needs both as well. Joining links a
Connector of your own in each recorded Workspace. Those links count only while
they cover exactly the recorded Workspaces and you are the person signed in, so
a pulled change to the Workspaces, or someone else signing in here, means
running connect again.
Session start says which is missing. An old or damaged config prompts you to
reconnect. The plugin does not convert it or
guess where its records should go.

For browser sign-in, the project file looks like this:

```json
{
  "authMode": "oauth",
  "profileId": "profile_…",
  "controlUrl": "https://augenta.ai",
  "endpoint": "https://gateway.example.com",
  "org": { "id": "org_…", "name": "Example" },
  "destinations": [
    { "connectorId": "connector_…", "workspaceId": "ws-…", "workspaceName": "Platform" }
  ],
  "autoRecall": false
}
```

`profileId` points to your saved sign-in. `destinations` lists the links and
Workspaces you chose. `autoRecall` records your answer to connect's automatic
recall question; it must be `true` or `false` if present. A config without it
predates the question and keeps automatic recall on until you reconnect. It must be a non-empty array; each entry requires
`connectorId` and `workspaceId`, while `workspaceName` is optional. The project
file has no sign-in token; it records the organization and Workspaces you chose
so the plugin can name them without asking the server. The server still decides
where each Connector routes and who may read a Workspace.

Recall checks each selected link live before sending the question. Disabled or
inaccessible Connectors, and links whose Workspace no longer matches the saved
choice, are skipped and reported; reconnect to review those destinations.

A browser-connected project from 0.10 or earlier needs one reconnect: its config
is in an older format that is not converted automatically. Connect reuses the
Connectors it already has.

Sign-in tokens stay in `~/.augenta/auth.json`. The directory uses mode `0700`
and the file uses `0600`, so only your OS account can access them. Tokens are
not printed into the chat.

Connect records the control URL and gateway used for this connection. Reconnecting
defaults to the recorded environment. Normal browser setup writes the needed values.

Changing connect's control URL selects the new environment's discovered gateway,
not the previous environment's saved endpoint. An explicit `--endpoint` still
takes precedence.

For a browser connection, connect takes the gateway from the environment's
sign-in discovery every time, or from an explicit `--endpoint` you pass when
connecting, which it tells you about before you sign in. It never takes the
gateway from `config.json` or from `AUGENTA_API_URL` alone, because a commit can
set both (the variable through a committed `.claude/settings.json`) and signing
in sends your new sign-in to that gateway straight away. When `AUGENTA_API_URL`
names a different gateway, connect stops and says so, with nothing sent. A
connection made with `--endpoint` keeps its `config.json` out of git, because
your teammates' sign-ins are for the environment's own gateway. Connect records
a discovered gateway as both `endpoint` and `discoveredGateway`; the marker is
bookkeeping, not another routing setting.

Connect names a non-production environment before you sign in, too: the sign-in
link belongs to that environment.

Your sign-in is only ever sent to the gateway it was made for. If
`config.json`, `AUGENTA_API_URL` or `AUGENTA_INGEST_URL` points a browser
connection anywhere else — a hand edit, a pulled commit, or a variable set by a
committed `.claude/settings.json` — capture and recall stop in that checkout and
the next session says where it points, and whether the file or a variable is the
cause. If you did not make that change, look at its history first. When the file
changed, connecting again restores the environment's own gateway; when a
variable is the cause, unsetting it is the fix.

| Setting in `config.json` | Environment override | What it selects |
| --- | --- | --- |
| `controlUrl` | `AUGENTA_CONTROL_URL` | Sign-in discovery; defaults to `https://augenta.ai` |
| `endpoint` | `AUGENTA_API_URL` | API gateway; defaults to production |
| `ingestUrl` | `AUGENTA_INGEST_URL` | Optional full capture URL; defaults to the gateway's `/v1/experiences` |

An explicit command flag wins over an environment variable, then the file, then
the default. For a browser connection, capture always goes to the sign-in's own
gateway host, so `ingestUrl` can change only the path, and connect keeps a hand-set
one only in that form.

A platform-key `config.json` holds its key, so it must never be committed. Connect
refuses to write one that git tracks, and one that git tracks does not capture or
recall; untrack it with `git rm --cached .augenta/config.json`.
Recall uses saved Workspace names immediately and refreshes names for its output
when the live list is available; it does not update the file.

## Attachment consent and upgrades

Connect and joining with `--adopt` disclose document capture and record
`attachmentsConsentedAt` in this checkout's `.augenta/state/links.json`.
It does not go in a browser project's shared `config.json`. The effective time
is available only while this checkout is joined under its own sign-in, project
and exact Workspace set. Existing joins keep their current activity and memory
capture with attachments disabled until reconnecting or joining again.
After reconnecting or joining again, a fresh supply reaches the current
Workspace set even when the document is unchanged. Duplicate supplies under
that consent are omitted, and revision ordering remains enforced across renewals.

Attachment observations must have an originating transcript timestamp at or after
consent; earlier history is not rescanned. For a mention, its initiating prompt
must also follow consent. Text is scrubbed and split; whole PDFs are not
secret-scrubbed, and every selected Workspace receives them. The supported PDF
Read path includes temporary/generated PDFs and page-range references.

Upgrade **every installed harness** that shares the project queue before
enabling attachments. Older shippers may silently skip attachment records. Codex
will ask for renewed hook trust because the hook manifest changes in this release.
Set `AUGENTA_CAPTURE_ATTACHMENTS=0`, `off` or `false` to stop new attachments.
`all` still excludes images. The main capture kill switch also stops them.

For an API-key config you write yourself, attachments are off unless you add
`attachmentsConsentedAt` as an explicit ISO timestamp after accepting the same
disclosure. It belongs only in the untracked local config. The human/CI
`connect --api-key` path records it after displaying the disclosure; neither
key verification nor sign-in repair changes consent.

## CI or a service

A job without a browser uses an API key. Its key is tied to one Connector and
one Workspace. It cannot use the browser flow's choice of several Workspaces.

1. In Augenta, open **Connectors** in the target Workspace. Choose **Connect**,
   then **CI or a service**. Copy the key when it is shown; it is shown once.
2. Store the key in your job's secret store. Never paste it into chat or type
   the key itself into a shell command, where it may be recorded.
3. Have the job write `.augenta/config.json` from that secret store:

   ```json
   {
     "authMode": "api-key",
     "apiKey": "<key from your secret store>"
   }
   ```

4. Before running the plugin, set `.augenta/` to mode `0700` and the config
   file to `0600`. Exclude the whole `.augenta/` folder from Git. It holds
   both the key and captured records.

The plugin reads the file directly. It sets the directory to `0700` and adds a
self-ignoring `.gitignore` on its next capture write. Set these protections
yourself during setup, before that first write. The plugin does not change
the permissions of a config file it did not write.

Only `authMode` and `apiKey` are required. `controlUrl`, `endpoint`, `ingestUrl`,
`org` (an `id` and optional `name`), and `destinations` are optional. If supplied,
`destinations` must contain exactly one entry. The key's server-side assignment
still determines its route. The terminal `connect --api-key` path records the
verified organization id and destination; never run that secret-bearing command
through an agent.

If your job calls the API directly, it does not need this file. Send
`Authorization: AugentaKey <key>` with each request. See the
[API key guide](https://augenta.ai/dashboard/keys/api) for a full example.

## Pause or disconnect

| What you want | What to do |
| --- | --- |
| Stop capture and recall for one project | Delete that project's `.augenta/config.json` |
| Pause capture and automatic recall across projects, but keep the recall command | Set `AUGENTA_CAPTURE_ENABLED=0` in the environment that starts your coding app |
| Turn automatic recall on or off for one project | Ask your agent, which runs connect with `--json --auto-recall on` or `off`; nothing else in the config changes |
| Turn off only automatic recall, for every project | Set `AUGENTA_AUTO_RECALL=0` in the environment that starts your coding app |
| Resume paused capture or automatic recall | Remove that variable and restart the app with the new environment |

Disconnecting does not erase local buffers or records already sent. Removing
a Workspace from the selected set also leaves its existing records in place.

## If something looks wrong

| What you see | What to check |
| --- | --- |
| “Node.js 20 or newer was not found” | Install or repair Node 20 or newer, then restart your coding app |
| No records in Experiences yet | Finish a turn, allow a short wait, and check the Workspace you chose |
| A request to sign in again | Run connect again and choose the full set of Workspaces |
| A refused API key | Check the key and whether its Connector is enabled; browser connect would replace the key setup |
| “Nothing remembered” | That Workspace may not have saved memory yet |
| “Recall unavailable” | Recall is not available in the connected Augenta environment |
| No automatic recall on a prompt | Automatic recall is off for the project, nothing matched, the prompt was a command or very short, Augenta did not answer within five seconds, or the sign-in needs renewing; ask with the recall command to see why |
| A notice about discarded records | Those records will not be retried; check the named connection |

For an unresolved problem, [report a bug](https://github.com/AugentaAI/augenta-plugin/issues).
Do not attach keys, config files, or private transcripts.
