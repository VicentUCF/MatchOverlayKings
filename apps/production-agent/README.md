# Production agent local setup

Copy `.env.example` into the local process environment and replace its placeholders. The agent
uses a publishable project key plus a local agent access token. Never provide a Supabase
service-role key. Keep any file used to populate the process environment owner-only (for example,
mode `0600`). `KPL_AGENT_SUPABASE_URL` accepts an HTTPS origin only: credentials, paths, queries,
and fragments are rejected. Credentials must not contain boundary whitespace or control
characters.

`KPL_AGENT_COURT_IDS` must contain exactly four unique court UUIDs. The runtime admits exactly
three concurrent pipelines; this is intentionally lower than the four-court assignment.

`KPL_AGENT_SECRET_ROOT` must be an absolute path owned by the agent account. Restrict the root
directory to that account (for example, mode `0700`) and secret files to owner read/write (mode
`0600`). A reference such as `local://outputs/program` resolves to
`$KPL_AGENT_SECRET_ROOT/outputs/program`. Empty files, directories, oversized files, traversal,
and symlinks are rejected. Directories inside the root must not be writable by group or other
users. Every ancestor above the root must be owned by either root or the agent's effective UID and
must either have no group/other write bits or use the POSIX sticky bit, as `/tmp` normally does.

This trust model is POSIX-specific. The agent trusts its own effective UID and therefore assumes
other processes running as that UID are trusted. Keep the root on a local filesystem with normal
POSIX ownership and mode semantics. Rotate a secret by writing a new owner-only regular file and
atomically renaming it over the old path; do not rewrite the live file in place.

Future media-process integration must borrow secret bytes only for the duration needed to pass
them through a non-command-line channel such as a dedicated file descriptor or standard input.
Secret values must never appear in child-process arguments, inherited environment variables, or
logs, and a borrow must not outlive the operation consuming it.

The current milestone provides configuration, secret-resolution, and JSON-lines logging
boundaries plus media planning and managed child-process primitives. Media planning is pinned to
MediaMTX `1.21.0`, emits an ephemeral YAML configuration for four loopback-only publisher paths,
enables a least-privilege authenticated loopback API, disables unused network protocols, and
produces shell-free FFmpeg plans for Linux `v4l2`, optional ALSA audio, optional raw overlay pixels
on file descriptor 4, progress on file descriptor 3, and local SRT/MPEG-TS output. The shared
MediaMTX service owns one generated credential, secure configuration artifact, and child process
per generation. Startup readiness requires the authenticated API to report exactly the four
configured paths; shutdown reaps the child before removing its configuration, with retryable
cleanup state when reaping or removal fails. The Node adapter starts plans without a shell or
inherited environment, drains fd3 eagerly into a bounded progress queue, pumps single-owner fd4
input with backpressure and cancellation, and supports deterministic shutdown and reaping.
Loopback-only SRT publishing is a trusted development boundary, not publisher authentication.
This milestone does not expose MediaMTX beyond loopback, capture browser pixels, publish to
YouTube, support Android/network cameras, or poll the control plane.

Verify locally with:

```bash
npm run build --workspace=@kpl/production-contracts
npm run typecheck:test --workspace=@kpl/production-agent
npm test --workspace=@kpl/production-agent
```
