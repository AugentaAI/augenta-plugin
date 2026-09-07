# Augenta

Your coding agents learn useful things every day, but most of that context
disappears when a session ends. The Augenta plugin captures activity and
project memory from projects you explicitly connect, then sends it to the
Augenta Workspaces you choose so it can become shared memory and skills — and
lets your agent ask those Workspaces what they remember.

## Quick start

Install the plugin in your app, connect a project, confirm it is working. The
console walks the same steps, with screenshots for the desktop apps, at
[Getting started](https://augenta.ai/dashboard/getting-started).

### Prerequisites

- **[Node.js](https://nodejs.org) 20 or newer, on your `PATH`.** The plugin's
  hooks run on it, and the connect skill shells out to `node` through your
  agent's own Bash tool — so a Node that exists only inside a version manager's
  shell function is not enough.
- **An Augenta account.** Sign in at [augenta.ai](https://augenta.ai). You get
  your own private Default Workspace on first sign-in, so there is always
  somewhere to connect to.

### Claude Code

Run these one at a time — Claude Code takes one slash command per message.

```text
/plugin marketplace add AugentaAI/augenta-plugin
```

```text
/plugin install augenta@augenta
```

Restart Claude Code, open the project you want to capture, and run:

```text
/augenta:connect
```

### Codex CLI

```bash
codex plugin marketplace add AugentaAI/augenta-plugin --ref main
```

```bash
codex plugin add augenta@augenta
```

Start a new session and trust the Augenta hooks when Codex asks. Codex asks
again after plugin updates; if you dismiss the prompt, run `/hooks`. Open the
project you want to capture and run:

```text
$augenta:connect
```

You can also ask Codex to "Connect Augenta."

### Claude Desktop

Open **Customize → Plugins → Add → Add marketplace**, enter
`https://github.com/AugentaAI/augenta-plugin`, keep automatic sync on, and
enable Augenta. Start a new Code or Cowork task with the project folder
attached, then choose Augenta's connect skill from the `/` or `+` menu.

### ChatGPT Desktop

Open **Plugins → Add → Add a marketplace**. Use
`https://github.com/AugentaAI/augenta-plugin` as the source, `main` as the Git
ref, and leave Sparse paths empty. Install or enable Augenta, then start a new
Codex or Work task with the project and run `$augenta:connect`, or ask the app
to connect Augenta.

## Connect and confirm

Connecting gives you an Augenta sign-in link to open in your browser, then asks
you to name **every** Workspace this project should feed. At least one is
required — your own Default Workspace is a fine start.

Name the complete set each time. The question is asked on every run, never
defaulted and never carried forward; reconnecting an already-connected project
shows the current set pre-selected, and that set has to be re-affirmed.

That selection is the consent boundary. The effective audience is the **union**
of everyone with access to any selected Workspace.

Then work in the project for a few minutes and open
[Getting started](https://augenta.ai/dashboard/getting-started) → **Confirm it's
working**. Capture is buffered locally and ships in the background, so a short
wait there is normal rather than a failure.

## Connecting CI or a service

A client with no browser to sign in with — CI, a scheduled job, a service — uses
an API key instead. A person can use a key too, but signing in is simpler.

1. **Create the key.** In the console, open **Connectors** in the Workspace it
   should write to, choose **Connect**, then **CI or a service**. That creates
   the Connector and shows its key once — copy it then.
2. **Give the key to the client.** If it runs this plugin, write
   `.augenta/config.json` in the project root from whatever secret store the
   client already uses — the plugin reads the file directly, there is nothing to
   run:

   ```json
   {
     "authMode": "api-key",
     "apiKey": "sk-aug-….secret"
   }
   ```

   If it calls Augenta's API directly instead, skip the file and send
   `Authorization: AugentaKey <key>` on each request. The console's
   [Calling the API with a key](https://augenta.ai/dashboard/keys/api) guide has
   a complete request.
3. **Lock it down.** Set `.augenta/` to mode `0700` and the config file to
   `0600` yourself. The plugin narrows the directory to `0700` and drops in a
   self-ignoring `.gitignore` on its next capture write — but that is after the
   fact, and a client calling the API directly never runs the plugin at all. The
   folder holds capture buffers beside the credential, so both the mode and the
   ignore rule matter.

Never paste a key into an agent conversation, and never type it at a shell —
both are recorded.

## Configuration

Everything about one project's connection lives in a single file inside that
project: `.augenta/config.json`. `/augenta:connect` writes it for you; you write
it yourself only for CI or a service, as above. There is no global settings file
and nothing to tune — the file is a consent record, not a preferences file, and
that is the whole reason it exists:

- **Capture is opt-in per project, and the file is the opt-in.** Its presence in
  a project root is what connects that project. No file, no capture. That is
  also why disconnecting one project is `rm .augenta/config.json` and not a
  command — there is no other state to get out of step with it.
- **It records which Workspaces you consented to.** `connectorIds` holds one
  Connector per Workspace you selected, so the destination set belongs to the
  project rather than to you or your machine. One laptop can feed this repo to
  your private Default Workspace and the repo next door to a shared one. A
  global file could not express that.
- **On the API-key path it is also the credential.** Signing in keeps your token
  in `~/.augenta/auth.json`, globally and reusable, and the project file holds
  only a reference to that profile. A browserless client has no profile to
  reference, so for it the file carries the key itself.

```json
{
  "authMode": "oauth",
  "profileId": "profile_…",
  "connectorIds": ["connector_…", "connector_…"]
}
```

`authMode` names the credential kind, which decides both what else the file must
contain and which authorization header the plugin sends. `connectorIds` is an
array and the only routing key read — no scalar is accepted beside it, because a
file offering both would let a reader take the scalar, ship to that one
destination, and go quietly single-destination with nobody told. `endpoint` is
accepted for pointing a client at a non-default environment.

What the file deliberately never carries: no OAuth token, no organization id and
no Workspace id. Augenta derives every coordinate server-side from the Connector
or key it authenticated, and refuses coordinates supplied by a client.

A config this plugin cannot parse is not migrated — it prompts you to reconnect
instead. Reusing stale routing would trade one clear reconnect for an
unexplained 401 later.

## Recall what Augenta remembers

Once a project is connected, ask its Workspaces what they already know:

```text
/augenta:recall what did we decide about the landing path
```

On Codex, use `$augenta:recall`, or just ask what Augenta remembers about
something. Your agent also reaches for it on its own when you ask what was
decided, tried, or learned before.

Every Workspace the project feeds is asked, and each answer is labelled with
the Workspace it came from. An answer is written by a model over the matching
memory, so a call can take up to a minute. **Only your question leaves the
machine** — no file contents and no transcript text. Augenta records that a
recall happened; it does not store the answer, and it keeps no copy of your
question — only a one-way fingerprint of it, used to notice a repeated request
that asks something different.

A brand-new Workspace has nothing to recall yet; that is normal, not an error.
Recall is available where Augenta has it deployed, and reports plainly when it
is not.

## What gets captured

Every selected Workspace receives the **full record**: the same normalized
agent activity, raw transcript records, and project memory. Normalized activity
and project memory are scrubbed for common credential patterns.

Raw transcript records are structurally sanitized but are **not
secret-scrubbed**. Only connect projects whose agent activity you are
comfortable sending to every Workspace you select.

**On request: recall.** A recall sends one thing — the question you asked, or
the one your agent formed from it — to each Workspace the project feeds. It
reads back; it adds nothing to what the project has captured. Augenta keeps no
copy of the question or the answer. It does record that a recall happened,
against a one-way fingerprint of the question text — enough to tell a retry from
a new question, and short questions are guessable from a fingerprint by anyone
who can read that record, so treat the question itself as visible to the
Workspace's audience.

To stop capture for one project, delete `.augenta/config.json`. To disable
capture globally, set `AUGENTA_CAPTURE_ENABLED=0`. That variable is the switch
for **capture** only: recall is a read, so it keeps working while the project
has a config. Deleting `.augenta/config.json` turns off both.

## Links

- [Getting Started](https://augenta.ai/dashboard/getting-started)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Issues](https://github.com/AugentaAI/augenta-plugin/issues)
- [License](LICENSE)
