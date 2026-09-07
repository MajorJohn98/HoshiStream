# Native runtime control

This is a local supervisor contract, not part of the tokenized LAN management
API. Implemented by `scripts/native-runtime.mjs` and `native-server.mjs`.

## State ownership

The runtime acquires `<state>/run/runtime.lock` before bootstrapping services.
The complete version-1 record contains the owning PID and a random instance
identity. Publication is create-if-absent and atomic; stale-owner recovery is
serialized. A live or malformed owner record is never silently overwritten.

Store application state on a local filesystem supporting atomic hard links
and private permissions (normally NTFS on Windows). This requirement is for
application state, not for separately registered media drives.

The compatibility `hoshistream.pid` file remains, but it is not a readiness
signal or sufficient authority to terminate a process.

## Local capability control

After initialization, the runtime binds an ephemeral port on `127.0.0.1` only.
The private `<state>/run/control.json` contains version, PID, instance, port,
and a random secret. Never publish this file or put the secret in process
arguments, URLs or logs. Windows files/directories use current-user and SYSTEM
ACLs; POSIX uses owner-only permissions.

| Request | Behavior |
|---|---|
| `GET /status` | Returns version, PID, instance, add-on port, `ready`, and `stopping`; never the secret |
| `POST /stop` | Acknowledges with 202, then starts asynchronous graceful shutdown |

Both require `Authorization: Bearer <control secret>`. Requests with an Origin
header or body are rejected; there is no CORS or public-browser access. The
access token for the add-on is not a control credential.

Clients compare the returned instance/PID with the private metadata before
acting. `ready` becomes true only after TorrServer and the add-on `/ready`
endpoint answer successfully. A live starting owner with no control endpoint
is reported as an unconfirmed stop, not "not running."

Prefer the CLI rather than reading metadata manually:

```text
node scripts/native-control.mjs status --state-dir=PATH
node scripts/native-control.mjs wait --state-dir=PATH
node scripts/native-control.mjs stop --state-dir=PATH
```

`wait --pid=PID` additionally requires the expected launched process.
The stop command waits boundedly for ownership release and never force-kills an
unverified PID. `prepare` creates private log storage for launch scripts.

## Attached desktop parent

With `--parent-control`, Node accepts a bounded newline-terminated command on
its inherited stdin:

```json
{"version":1,"command":"shutdown"}
```

EOF also requests shutdown. This stream is inherited from the owning native
shell, not exposed on the network. The parent must keep it open while the
runtime is needed.

On Windows the shell holds the runtime tree in a Job Object and uses bounded
force cleanup only after graceful shutdown fails. The Node launcher does not
depend on Unix signal semantics or a changing parent PID on Windows.
