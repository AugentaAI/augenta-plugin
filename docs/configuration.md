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
| `<project>/.augenta/config.json` | This project's connection settings |
| `<project>/.augenta/outbox/` | Records waiting to be sent, plus delivery state |
| `~/.augenta/auth.json` | Your saved sign-in, shared across connected projects |

The plugin needs a readable project config to capture or recall. An old or
damaged config prompts you to reconnect. The plugin does not convert it or
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
  ]
}
```

`profileId` points to your saved sign-in. `destinations` lists the links and
Workspaces you chose. It must be a non-empty array; each entry requires
`connectorId` and `workspaceId`, while `workspaceName` is optional. The project
file has no sign-in token; it records the organization and Workspaces you chose
so the plugin can name them without asking the server. The server still decides
where each Connector routes and who may read a Workspace.

Recall checks each selected link live before sending the question. Disabled or
inaccessible Connectors, and links whose Workspace no longer matches the saved
choice, are skipped and reported; reconnect to review those destinations.

Older `connectorIds` configs require a single reconnect per project. They are
not converted automatically.

Sign-in tokens stay in `~/.augenta/auth.json`. The directory uses mode `0700`
and the file uses `0600`, so only your OS account can access them. Tokens are
not printed into the chat.

Connect records the control URL and gateway used for this connection. Reconnecting
defaults to the recorded environment. Normal browser setup writes the needed values.

Changing connect's control URL selects the new environment's discovered gateway,
not the previous environment's saved endpoint. An explicit `--endpoint` or
`AUGENTA_API_URL` still takes precedence.

For an automatically discovered endpoint, connect also records `discoveredGateway`.
When it still matches `endpoint`, reconnect refreshes both from discovery so gateway
rotations are picked up. A hand-edited endpoint, or one explicitly selected with
`--endpoint` or `AUGENTA_API_URL`, remains an override within the saved environment.
The marker is local bookkeeping, not another routing setting; capture and recall
continue using `endpoint` until reconnect updates it.

| Setting in `config.json` | Environment override | What it selects |
| --- | --- | --- |
| `controlUrl` | `AUGENTA_CONTROL_URL` | Sign-in discovery; defaults to `https://augenta.ai` |
| `endpoint` | `AUGENTA_API_URL` | API gateway; defaults to production |
| `ingestUrl` | `AUGENTA_INGEST_URL` | Optional full capture URL; defaults to the gateway's `/v1/experiences` |

An explicit command flag wins over an environment variable, then the file, then
the default. Connect preserves a hand-set `ingestUrl` when it rewrites the file.
Recall uses saved Workspace names immediately and refreshes names for its output
when the live list is available; it does not update the file.

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
| Pause capture across projects, but keep recall | Set `AUGENTA_CAPTURE_ENABLED=0` in the environment that starts your coding app |
| Resume paused capture | Remove that variable and restart the app with the new environment |

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
| A notice about discarded records | Those records will not be retried; check the named connection |

For an unresolved problem, [report a bug](https://github.com/AugentaAI/augenta-plugin/issues).
Do not attach keys, config files, or private transcripts.
