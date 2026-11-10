import cluster from 'node:cluster';

type Handler = (payload: any) => void;

const handlers = new Map<string, Set<Handler>>();
let listening = false;

function deliver(topic: string, payload: unknown) {
  for (const h of handlers.get(topic) ?? []) {
    try {
      h(payload);
    } catch {
      /* subscriber errors must not break the bus */
    }
  }
}

/**
 * Tiny pub/sub that spans all worker processes of one container (RELAY_WORKERS>1):
 * messages go to the cluster primary, which fans them out to every worker.
 * Used to propagate cache invalidations (key revoked, config changed) and spend
 * totals instantly. Across separate instances, short TTLs bound staleness.
 */
export const bus = {
  subscribe(topic: string, handler: Handler) {
    if (!handlers.has(topic)) handlers.set(topic, new Set());
    handlers.get(topic)!.add(handler);
    if (!listening && cluster.isWorker) {
      listening = true;
      process.on('message', (msg: any) => {
        if (msg?.relayBus && msg.from !== process.pid) deliver(msg.topic, msg.payload);
      });
    }
  },
  publish(topic: string, payload: unknown = null) {
    deliver(topic, payload);
    if (cluster.isWorker && process.send) process.send({ relayBus: true, topic, payload, from: process.pid });
  },
};

/** Call in the cluster primary: relays bus messages to all workers. */
export function startBusRelay() {
  cluster.on('message', (_worker, msg: any) => {
    if (!msg?.relayBus) return;
    for (const w of Object.values(cluster.workers ?? {})) if (w && w.isConnected()) w.send(msg);
  });
}
