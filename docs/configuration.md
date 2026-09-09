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
  "connectorIds": ["connector_…", "connector_…"]
}
```

`profileId` points to your saved sign-in. `connectorIds` lists the links for
the Workspaces you chose. It must be a non-empty array. The project file has
no sign-in token, organization id, or Workspace id.

Sign-in tokens stay in `~/.augenta/auth.json`. The directory uses mode `0700`
and the file uses `0600`, so only your OS account can access them. Tokens are
not printed into the chat.

An optional `endpoint` stores the gateway URL used for this connection.
Normal browser setup writes the needed values; you do not need to edit them.

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
| No records in Experiences yet | Finish a turn, allow a short wait, and check the Workspace you chose |
| A request to sign in again | Run connect again and choose the full set of Workspaces |
| A refused API key | Check the key and whether its Connector is enabled; browser connect would replace the key setup |
| “Nothing remembered” | That Workspace may not have saved memory yet |
| “Recall unavailable” | Recall is not available in the connected Augenta environment |
| A notice about discarded records | Those records will not be retried; check the named connection |

For an unresolved problem, [report a bug](https://github.com/AugentaAI/augenta-plugin/issues).
Do not attach keys, config files, or private transcripts.
