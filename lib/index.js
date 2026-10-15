/**
 * dsh-netflow-dock — host half.
 *
 * Samples the Linux kernel's per-interface byte counters from `/proc/net/dev`
 * once a second, turns counter deltas into up/down rates, keeps a short
 * in-memory rate window, and publishes the result as JSON on one exact HTTP
 * route. It owns no durable state and writes nothing to disk: the kernel
 * counters ARE the persistent record, so a restart re-reads them and only the
 * in-memory rate window is lost.
 *
 * The route path is deliberately distinct from `dsh-netflow`'s
 * (`/netflow/snapshot`). Both packages may be mounted at once — the floating
 * window and this composer readout are independent surfaces — and the web
 * server requires configured route paths to be distinct.
 *
 * @module dsh-netflow-dock
 */

import { readFileSync } from 'node:fs'

/** Kernel interface counters. Linux-only; a missing file reports `ok: false`. */
const PROC_NET_DEV = '/proc/net/dev'
/** Sampling period. Also the resolution of every rate this module reports. */
const SAMPLE_MS = 1000
/** Rate-window length: SAMPLE_MS * HISTORY_MAX ≈ two minutes of history. */
const HISTORY_MAX = 120
/** Exact route path. Must not collide with another row's configured route. */
const ROUTE_PATH = '/netflow-dock/snapshot'

/**
 * Parse `/proc/net/dev` into per-interface byte counters.
 *
 * The file is two header lines followed by one line per interface:
 * `iface: rxBytes rxPackets … txBytes txPackets …` (16 numeric columns).
 * Only the two byte counters this module needs are read, so a future kernel
 * adding columns after them cannot break the parse.
 *
 * @param {string} text - raw file contents.
 * @returns {Record<string, { rx: number, tx: number }>} counters by interface name.
 */
function parseProcNetDev(text) {
  /** @type {Record<string, { rx: number, tx: number }>} */
  const interfaces = {}
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const name = line.slice(0, separator).trim()
    if (name.length === 0) continue
    const columns = line.slice(separator + 1).trim().split(/\s+/)
    if (columns.length < 9) continue
    const rx = Number(columns[0])
    const tx = Number(columns[8])
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    interfaces[name] = { rx, tx }
  }
  return interfaces
}

/**
 * Reduce an unknown thrown value to a readable message.
 * @param {unknown} error - thrown value.
 * @returns {string} a message safe to put on the wire.
 */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  return String(error)
}

export default {
  name: 'dsh-netflow-dock',
  inject: ['timer', 'webServer'],

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - this row's fiber context.
   */
  apply(ctx) {
    /** @type {{ at: number, interfaces: Record<string, { rx: number, tx: number }> } | null} */
    let previous = null
    /** @type {Array<{ rx: number, tx: number }>} */
    const history = []
    const peak = { rx: 0, tx: 0 }
    /** @type {object | null} */
    let snapshot = null
    let samples = 0
    let reading = false

    function log(message) {
      try {
        ctx.logger.info(message)
      } catch {
        console.log(`[dsh-netflow-dock] ${message}`)
      }
    }

    /**
     * The wire view. `historyLimit` trims the rate window without touching the
     * stored one, so the readout — which needs no chart — can poll cheaply.
     * @param {number} historyLimit - trailing history entries to include.
     * @returns {object} JSON-safe snapshot.
     */
    function buildSnapshot(historyLimit) {
      return {
        ok: true,
        at: Date.now(),
        source: 'proc',
        intervalMs: SAMPLE_MS,
        samples,
        interfaceCount: 0,
        rxRate: 0,
        txRate: 0,
        rxTotal: 0,
        txTotal: 0,
        peak: { rx: peak.rx, tx: peak.tx },
        rows: [],
        history: historyLimit >= 0 ? history.slice(Math.max(0, history.length - historyLimit)) : [],
        error: null,
      }
    }

    /** Read one counter sample and fold it into the rate window. */
    async function sample() {
      if (reading) return
      reading = true
      try {
        const interfaces = parseProcNetDev(readFileSync(PROC_NET_DEV, 'utf8'))
        const at = Date.now()

        let elapsed = 0
        if (previous !== null) {
          const delta = (at - previous.at) / 1000
          // A tick gap is normal; a zero or absurd delta means sleep/resume or a
          // clock jump, where a delta-derived rate would be meaningless.
          if (delta > 0.05 && delta < 600) elapsed = delta
        }

        const names = Object.keys(interfaces)
        /** @type {Array<object>} */
        const rows = []
        let rxRate = 0
        let txRate = 0
        let rxTotal = 0
        let txTotal = 0

        for (const name of names) {
          const current = interfaces[name]
          const before = previous?.interfaces[name]
          let interfaceRxRate = 0
          let interfaceTxRate = 0
          if (before !== undefined && elapsed > 0) {
            const rxDelta = current.rx - before.rx
            const txDelta = current.tx - before.tx
            // A negative delta is a counter reset or wrap, not traffic flowing
            // backwards; report zero rather than a nonsensical negative spike.
            if (rxDelta >= 0) interfaceRxRate = rxDelta / elapsed
            if (txDelta >= 0) interfaceTxRate = txDelta / elapsed
          }
          // Loopback carries the harness's own local traffic (the web UI's
          // socket to its own server). It is excluded from the totals the
          // readout shows, but still reported per interface for completeness.
          const loopback = name === 'lo'
          rows.push({
            name,
            loopback,
            rxRate: interfaceRxRate,
            txRate: interfaceTxRate,
            rxTotal: current.rx,
            txTotal: current.tx,
          })
          if (!loopback) {
            rxRate += interfaceRxRate
            txRate += interfaceTxRate
            rxTotal += current.rx
            txTotal += current.tx
          }
        }

        rows.sort((a, b) => {
          const byActivity = b.rxRate + b.txRate - (a.rxRate + a.txRate)
          if (byActivity !== 0) return byActivity
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        })

        if (elapsed > 0) {
          history.push({ rx: rxRate, tx: txRate })
          while (history.length > HISTORY_MAX) history.shift()
          if (rxRate > peak.rx) peak.rx = rxRate
          if (txRate > peak.tx) peak.tx = txRate
        }

        samples += 1
        snapshot = {
          ...buildSnapshot(-1),
          at,
          samples,
          interfaceCount: names.length,
          rxRate,
          txRate,
          rxTotal,
          txTotal,
          rows,
          error: null,
        }
        previous = { at, interfaces }
      } catch (error) {
        // Keep the last good reading visible and flag it stale, so a transient
        // read failure degrades the readout instead of blanking it.
        const message = messageOf(error)
        snapshot = {
          ...(snapshot ?? buildSnapshot(-1)),
          ok: false,
          error: snapshot === null ? `reading ${PROC_NET_DEV} failed: ${message}` : message,
          peak: { rx: peak.rx, tx: peak.tx },
          history: [],
        }
      } finally {
        reading = false
      }
    }

    /**
     * @param {import('node:http').ServerResponse} res - response to own.
     * @param {number} status - HTTP status.
     * @param {unknown} payload - JSON-serializable body.
     */
    function sendJson(res, status, payload) {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
      })
      res.end(body)
    }

    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    async function handle(req, res) {
      try {
        const url = new URL(req.url ?? ROUTE_PATH, 'http://localhost')
        const params = url.searchParams

        if (params.get('reset') === '1') {
          history.length = 0
          peak.rx = 0
          peak.tx = 0
        }
        if (params.get('refresh') === '1') await sample()
        if (snapshot === null) await sample()

        let historyLimit = HISTORY_MAX
        const requested = params.get('history')
        if (requested !== null) {
          const parsed = Number(requested)
          if (Number.isFinite(parsed) && parsed >= 0 && parsed <= HISTORY_MAX) {
            historyLimit = Math.floor(parsed)
          }
        }

        const current = snapshot ?? buildSnapshot(-1)
        sendJson(res, 200, {
          ...current,
          peak: { rx: peak.rx, tx: peak.tx },
          history: history.slice(Math.max(0, history.length - historyLimit)),
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: messageOf(error) })
      }
    }

    // Every registration is owned by this fiber, so unloading the row removes
    // the route and stops the sampler with no residue.
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: handle }))
    ctx.effect(() => ctx.interval(() => { void sample() }, SAMPLE_MS))
    void sample()

    log(`monitoring ${PROC_NET_DEV} every ${SAMPLE_MS}ms, serving ${ROUTE_PATH}`)
  },
}
