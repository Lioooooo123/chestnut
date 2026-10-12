# Host model gateway

`startModelGateway` runs in the trusted outer worker. The API key belongs only in
that worker's environment/configuration and this gateway's memory. Do not put it
in the bot database, Pi model configuration, sandbox environment, or logs.

- Only `POST /v1/chat/completions` is exposed, for one exact configured model.
- The only upstream is `https://api.openai.com/v1/chat/completions`. Requests do
  not follow redirects, and client headers are never forwarded.
- Requests have a 2 MiB body cap, two concurrent requests, one completion, a
  default output cap of 4,096 tokens, and a 120-second overall deadline.
- Messages are text-only; tools are function declarations. URL-backed media,
  server-side tools, storage, and unknown top-level fields are rejected.
- `store: false` is forced. Limits supplied by the client may lower the token
  cap but cannot raise it.
- Successful output streams with backpressure. Exact accidental credential
  echoes are redacted across chunk boundaries; upstream errors and headers are
  not returned. There is no request or credential logging.
- Downstream disconnect, request timeout, and gateway shutdown abort upstream
  work.

Use a normalized absolute Unix socket path. Its parent must be owned by the
worker's user and mode `0700`; missing directories are created with that mode.
Existing files/sockets and symlink path components are rejected. The socket is
mode `0600`. Mount only its parent directory read-only into the network-disabled
container. Keep the host-side directory and its ancestors under trusted control;
same-user hostile host processes are outside this boundary.

The optional `fetchImpl` and exported `createGatewayHttpServer` are test seams;
production should call `startModelGateway` and use native fetch. Do not expose the
HTTP core on an external TCP interface.

Run `node --test tests/gateway.test.ts`. The HTTP tests use in-memory duplex
streams and do not prove Unix socket or container integration. A separate live
Unix-socket test checks permissions and cleanup; it explicitly skips only when
the executor returns `EPERM` for socket binding. No real API requests are made by
these tests.
