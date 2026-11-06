/**
 * dsh-cost-strip — browser half.
 *
 * Contributes one ambient readout under the composer: the accumulated CNY cost
 * of the current conversation, priced with DeepSeek's published peak /
 * off-peak rates.
 *
 * Pricing model (CNY per million tokens). Edit PRICES to follow a price change;
 * nothing else in this file needs to move.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-strip',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')

    /* ------------------------------------------------------------------ *
     * Price table
     * ------------------------------------------------------------------ */

    /** CNY per million tokens, DeepSeek official rates. */
    const PRICES = {
      'deepseek-v4-flash': {
        label: 'V4.1 Flash',
        offpeak: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 },
        peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
      },
      'deepseek-v4-pro': {
        label: 'V4 Pro',
        offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
        peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
      },
    }

    /** Rate card for a model this table does not know. */
    const FALLBACK_MODEL = 'deepseek-v4-flash'

    /**
     * Peak windows in Beijing time, as [startMinute, endMinute) of the day.
     * Everything outside them is off-peak; weekends are off-peak all day
     * (effective 2026-08-23).
     */
    const PEAK_WINDOWS = [
      [9 * 60, 12 * 60],
      [14 * 60, 18 * 60],
    ]

    /**
     * Whether an instant falls in a peak window.
     * @param {number} timeMs - epoch milliseconds.
     * @returns {boolean} true for a weekday inside a peak window.
     */
    function isPeak(timeMs) {
      const at = new Date(timeMs)
      const day = at.getDay()
      if (day === 0 || day === 6) return false
      const minute = at.getHours() * 60 + at.getMinutes()
      for (const window of PEAK_WINDOWS) {
        if (minute >= window[0] && minute < window[1]) return true
      }
      return false
    }

    /**
     * Resolve the rate card and tier for one model at one instant.
     * @param {string} model - provider model id.
     * @param {number} timeMs - when the call happened.
     * @returns {{ entry: object, tier: object }} the model entry and its tier.
     */
    function rateAt(model, timeMs) {
      const entry = PRICES[model] ?? PRICES[FALLBACK_MODEL]
      return { entry, tier: isPeak(timeMs) ? entry.peak : entry.offpeak }
    }

    /* ------------------------------------------------------------------ *
     * Reading the conversation snapshot
     * ------------------------------------------------------------------ */

    /**
     * Read the billable token buckets off one assistant node.
     *
     * `usage` is opaque in the snapshot contract, so every field is read
     * defensively. DeepSeek reports DISJOINT buckets: `inputTokens` already
     * excludes the cache-hit tokens. `cacheWriteTokens` is priced as a cache
     * miss because DeepSeek has no separate standing cache-write rate.
     *
     * @param {object} node - a settled assistant conversation node.
     * @returns {{ cacheMiss: number, cacheHit: number, output: number } | null}
     *   billable buckets, or null when the node reports no usage at all.
     */
    function readBilled(node) {
      const usage = node?.usage
      if (usage === null || typeof usage !== 'object') return null
      const read = (key) => {
        const value = usage[key]
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
      }
      const billed = {
        cacheMiss: read('inputTokens') + read('cacheWriteTokens'),
        cacheHit: read('cacheReadTokens'),
        output: read('outputTokens'),
      }
      if (billed.cacheMiss + billed.cacheHit + billed.output === 0) return null
      return billed
    }

    /**
     * Identify the model that produced one assistant node.
     * @param {object} node - a settled assistant conversation node.
     * @returns {string} the provider model id, falling back to the default card.
     */
    function modelOf(node) {
      const requestModel = node?.requestConfig?.model
      if (typeof requestModel === 'string' && requestModel.length > 0) return requestModel
      const provenanceModel = node?.provenance?.model
      if (typeof provenanceModel === 'string' && provenanceModel.length > 0) return provenanceModel
      return FALLBACK_MODEL
    }

    /**
     * Price one assistant node.
     * @param {object} node - a settled assistant conversation node.
     * @returns {{ cost: number, model: string, peak: boolean } | null}
     *   the priced row, or null when the node carries no usage.
     */
    function priceNode(node) {
      const billed = readBilled(node)
      if (billed === null) return null
      const timeMs = typeof node.time === 'number' ? node.time : Date.now()
      const { entry, tier } = rateAt(modelOf(node), timeMs)
      const cost =
        (billed.cacheMiss * tier.cacheMiss +
          billed.cacheHit * tier.cacheHit +
          billed.output * tier.output) /
        1e6
      return { cost, model: entry.label, peak: isPeak(timeMs) }
    }

    /**
     * Fold the loaded conversation window into a cost total.
     * @param {readonly object[]} nodes - conversation snapshot nodes.
     * @returns {{ total: number, calls: number, peakCalls: number, byModel: Array<[string, number]> }}
     *   the folded figures.
     */
    function foldCost(nodes) {
      let total = 0
      let calls = 0
      let peakCalls = 0
      const byModel = new Map()
      for (const node of nodes) {
        if (node?.kind !== 'assistant') continue
        const row = priceNode(node)
        if (row === null) continue
        total += row.cost
        calls += 1
        if (row.peak) peakCalls += 1
        byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.cost)
      }
      return { total, calls, peakCalls, byModel: Array.from(byModel.entries()) }
    }

    /**
     * Format a CNY amount with enough precision to stay meaningful when small.
     * @param {number} yuan - amount in yuan.
     * @returns {string} the display string.
     */
    function formatMoney(yuan) {
      if (!(yuan > 0)) return '¥0'
      if (yuan >= 1) return `¥${yuan.toFixed(2)}`
      if (yuan >= 0.01) return `¥${yuan.toFixed(3)}`
      return `¥${yuan.toFixed(4)}`
    }

    /* ------------------------------------------------------------------ *
     * Component
     * ------------------------------------------------------------------ */

    /**
     * The ambient cost readout rendered in `conversation.composer.dock`.
     * @param {{ useSession: Function }} props - the slot's session selector seat.
     * @returns {object} the React element.
     */
    function CostStrip({ useSession }) {
      const nodes = useSession((snapshot) => snapshot.nodes)
      const folded = react.useMemo(() => foldCost(nodes ?? []), [nodes])

      if (folded.calls === 0) return null

      const breakdown = folded.byModel.map(([label, amount]) => `${label} ${formatMoney(amount)}`).join(' · ')
      const tooltip = [
        `本次对话已花费 ${formatMoney(folded.total)}`,
        breakdown,
        `${folded.calls} 次模型调用，其中高峰时段 ${folded.peakCalls} 次`,
        '按消息发生时刻判定高峰 / 空闲；周六日全天按空闲价',
      ]
        .filter((line) => line !== '')
        .join('\n')

      return react.createElement(
        'div',
        { className: 'dshCostStrip_root', title: tooltip },
        react.createElement('span', { className: 'dshCostStrip_label' }, '本次对话'),
        react.createElement('span', { className: 'dshCostStrip_value' }, formatMoney(folded.total)),
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    const CSS = [
      '.dshCostStrip_root{display:flex;align-items:center;justify-content:center;gap:6px;',
      'margin:0 auto;padding:2px 0 0;max-width:var(--dsh-chat-content-width);',
      'font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);',
      'white-space:nowrap;cursor:default;}',
      '.dshCostStrip_label{opacity:.9;}',
      '.dshCostStrip_value{font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-secondary);font-weight:500;}',
    ].join('')

    const CSS_TAG = '@dsh-cost-strip/dsh-cost-strip/lib/client.js/CostStrip.css'

    /** Required services: the slot registry is this plugin's only dependency. */
    const inject = ['slots']

    /**
     * Client plugin body: insert the stylesheet once and claim the dock seat.
     * @param {object} ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-cost-strip'
        tag.dataset.pluginCss = CSS_TAG
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'cost-strip: stylesheet')

      ctx.effect(() =>
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-cost-strip', order: 200 },
            CostStrip,
          ),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
