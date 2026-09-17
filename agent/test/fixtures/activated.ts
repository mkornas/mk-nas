/** The agent's listener as mk-nasd.service runs it: the socket comes from whoever started this (systemd-socket-activate in the test). */
import { Db } from '../../src/db.ts';
import { listen, systemdFd } from '../../src/server.ts';

const fd = systemdFd();
if (fd === null) {
  console.error('no socket was handed over');
  process.exit(2);
}
await listen({ socket: '/nonexistent/never-used.sock', fd, audit: async () => {}, deps: { db: new Db(':memory:') } as never });
process.on('SIGTERM', () => process.exit(0));
