// Guest keepalive only. This writable file is NOT a trusted cleanup mechanism.
// The outer worker stops the complete container and inspects Docker state.
setInterval(() => {}, 60_000);
