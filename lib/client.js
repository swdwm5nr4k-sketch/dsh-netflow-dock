/**
 * dsh-netflow-dock — browser half.
 *
 * A client plugin bundle in the lazy-CJS shape the web shell's module table
 * expects: a classic script that registers one factory with
 * `window.__ModuleLoader__.load({ id, factory })`. Executing this file only
 * REGISTERS the factory; every side effect (the style tag, the slot
 * registration) lives inside the factory closure and runs at materialization.
 *
 * Contributes exactly ONE surface: a compact up/down readout appended to
 * `conversation.composer.dock`, the band under the composer card, beside the
 * shipped stats line. It deliberately does not touch `tool.view.cordis` —
 * that seat belongs to dynamic Cordis packages and cannot be registered by a
 * statically composed bundle.
 *
 * Data arrives over the host half's exact route rather than a Remote service:
 * a plain HTTP endpoint keeps this half free of API-generation machinery.
 *
 * @module dsh-netflow-dock/client
 */

;(function () {
  'use strict'

  /** Bundle id — must equal the package name, which is the graph row key. */
  var ID = 'dsh-netflow-dock'
  /** Exact route registered by the host half. */
  var ENDPOINT = '/netflow-dock/snapshot'
  /** Polling period. Slower than the host's 1s sample: this is an ambient
   * readout, and a 2s cadence halves the request rate for no visible loss. */
  var POLL_MS = 2000

  var CSS = [
    '.nf-dock{display:inline-flex;align-items:center;gap:10px;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.nf-dock-rx{color:var(--dsw-alias-brand-primary)}',
    '.nf-dock-tx{color:var(--dsw-alias-state-success-primary)}',
  ].join('\n')

  /**
   * @param {number} bps - bytes per second.
   * @returns {string} human-readable rate.
   */
  function fmtRate(bps) {
    if (typeof bps !== 'number' || !Number.isFinite(bps) || bps < 0) return '—'
    if (bps < 1024) return Math.round(bps) + ' B/s'
    var units = ['KB/s', 'MB/s', 'GB/s', 'TB/s']
    var value = bps / 1024
    var unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value = value / 1024
      unit++
    }
    var text = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : String(Math.round(value))
    return text + ' ' + units[unit]
  }

  /**
   * @param {number} bytes - byte count.
   * @returns {string} human-readable size.
   */
  function fmtBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
    if (bytes < 1024) return Math.round(bytes) + ' B'
    var units = ['KB', 'MB', 'GB', 'TB', 'PB']
    var value = bytes / 1024
    var unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value = value / 1024
      unit++
    }
    var text = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : String(Math.round(value))
    return text + ' ' + units[unit]
  }

  /**
   * @param {unknown} error - thrown value.
   * @returns {string} message suitable for display.
   */
  function errorText(error) {
    if (error === null || error === undefined) return ''
    if (typeof error === 'string') return error
    if (typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
      return error.message
    }
    return String(error)
  }

  /**
   * Sum per-interface rows, excluding loopback. `lo` carries the harness's own
   * local traffic (the UI's socket to its own server, which reaches gigabytes
   * on this host) and would swamp a readout meant to show real traffic.
   * @param {Array<object> | null} rows - host rows.
   * @returns {{ rx: number, tx: number, rxTotal: number, txTotal: number }} totals.
   */
  function sumExternal(rows) {
    var total = { rx: 0, tx: 0, rxTotal: 0, txTotal: 0 }
    if (!rows) return total
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      if (row.loopback) continue
      total.rx += row.rxRate
      total.tx += row.txRate
      total.rxTotal += row.rxTotal
      total.txTotal += row.txTotal
    }
    return total
  }

  /**
   * Build the plugin the module table hands to the vendored Loader.
   * @param {(specifier: string) => unknown} require - synchronous module-table require.
   * @returns {object} the Cordis client plugin.
   */
  function factory(require) {
    var React = require('react')

    /**
     * Poll the host route on a fiber-owned timer.
     * @param {object} ctx - client fiber context (for `ctx.interval`).
     * @returns {{ data: object | null, error: string | null }} latest reading.
     */
    function useFlow(ctx) {
      var pair = React.useState({ data: null, error: null })
      var state = pair[0]
      var setState = pair[1]
      React.useEffect(function () {
        var alive = true
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        function pull() {
          var init = { headers: { accept: 'application/json' }, cache: 'no-store' }
          if (controller !== null) init.signal = controller.signal
          fetch(ENDPOINT + '?history=0', init)
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then(function (result) {
              if (!alive) return
              setState({ data: result, error: null })
            })
            .catch(function (error) {
              if (!alive) return
              if (error !== null && error !== undefined && error.name === 'AbortError') return
              setState(function (previous) {
                // Keep the last good numbers visible; surface the failure in
                // the tooltip rather than blanking the readout.
                return { data: previous.data, error: errorText(error) }
              })
            })
        }
        pull()
        var dispose = ctx.interval(pull, POLL_MS)
        return function () {
          alive = false
          if (controller !== null) controller.abort()
          if (typeof dispose === 'function') dispose()
        }
      }, [])
      return state
    }

    /** The ambient composer-dock readout. */
    function DockReadout(props) {
      var flow = useFlow(props.ctx)
      var data = flow.data
      var totals = sumExternal(data !== null && data !== undefined ? data.rows : null)

      var tooltip = '服务器实时流量（不含回环）'
        + ' · 累计 ↓ ' + fmtBytes(totals.rxTotal)
        + ' / ↑ ' + fmtBytes(totals.txTotal)
      if (data !== null && data !== undefined) {
        tooltip += ' · 采样 ' + data.samples + ' 次'
      }
      if (flow.error !== null) {
        tooltip += ' · 读取失败：' + flow.error
      } else if (data !== null && data !== undefined && data.ok === false) {
        tooltip += ' · 读取失败：' + errorText(data.error)
      }

      return React.createElement('span', { className: 'nf-dock', title: tooltip },
        React.createElement('span', { className: 'nf-dock-rx' },
          data === null || data === undefined ? '↓ …' : '↓ ' + fmtRate(totals.rx)),
        React.createElement('span', { className: 'nf-dock-tx' },
          data === null || data === undefined ? '↑ …' : '↑ ' + fmtRate(totals.tx)),
      )
    }

    return {
      name: ID,
      // `slots` is the surface this bundle contributes to; `timer` backs the
      // polling interval, which must be fiber-owned so unloading stops it.
      inject: ['slots', 'timer'],

      /**
       * @param {object} ctx - this entry's client fiber context.
       */
      apply(ctx) {
        var style = document.createElement('style')
        style.setAttribute('data-plugin', ID)
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(function () {
          return function () {
            style.remove()
          }
        })

        // `slots.inject` waits for the declaration rather than assuming slot
        // registration order. The id is our own ('netflow'), so this cell is
        // added beside the shipped 'stats' entry; order 1 places it after.
        ctx.slots.inject('conversation.composer.dock', function () {
          ctx.effect(function () {
            return ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'netflow', order: 1 },
              function () {
                return React.createElement(DockReadout, { ctx: ctx })
              },
            )
          })
        })
      },
    }
  }

  var loader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__
  if (loader === undefined || loader === null) {
    console.error('[dsh-netflow-dock] window.__ModuleLoader__ is missing; plugin bundles must run after the shell module table exists')
  } else {
    loader.load({ id: ID, factory: factory })
  }
})()
