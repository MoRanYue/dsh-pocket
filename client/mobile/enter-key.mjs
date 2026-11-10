// 手机软键盘的回车 = 换行。
//
// 官方 composer 是 Lexical 编辑器：KEY_ENTER_COMMAND 在 CRITICAL 优先级里
// 先 preventDefault 再 submit()，Shift+Enter 才会落到「插入换行」。移动端
// 没有物理键盘时，虚拟键盘的回车键就是用户唯一能按到的「回车」，如果它直接
// 发送，长段落就永远敲不出来。
//
// 这里不另写一套编辑器逻辑，只在 window 捕获阶段把「软键盘的裸回车」改写成
// Shift+Enter（给事件实例遮蔽 shiftKey），后面 Lexical / 官方 keymap 拿到的
// 就是它们本来就支持的换行手势：
//   - Chrome/Android：官方 keymap 返回 false，@lexical/plain-text 插入换行；
//   - iOS/Safari：官方 keymap 返回 false，浏览器自己插入段落，beforeinput
//     照常回流到 Lexical（与用户按 Shift+Enter 完全同一条路径）。
// 因此不需要 preventDefault，也不会绕过编辑器的状态同步。
//
// 「是不是软键盘」靠两条信号判断，任一为真即认为是软键盘：
//   1. KeyboardEvent.sourceCapabilities.firesTouchEvents === true（Chrome/Edge）；
//   2. 视觉视口比布局视口矮了一截 —— 软键盘弹出时 visualViewport 收缩，接了
//      物理键盘（iOS/Android 都会收起软键盘）时两者几乎等高。
// 明确的硬件信号（firesTouchEvents === false，或软键盘没弹出）则原样放行，
// 于是「连了键盘的移动端」保持 Shift+Enter 换行、回车发送。

/** 软键盘弹出时视觉视口至少要比布局视口矮这么多。 */
export const SOFT_KEYBOARD_GAP = 80

/** composer 的 contenteditable 宿主（ComposerContentEditable 上的稳定属性）。 */
const COMPOSER_INPUT = '[data-composer-input]'

/**
 * 判断一次 keydown 应该怎么处理。
 * @param {{
 *   key?: string,
 *   isComposing?: boolean,
 *   keyCode?: number,
 *   shiftKey?: boolean,
 *   altKey?: boolean,
 *   ctrlKey?: boolean,
 *   metaKey?: boolean,
 *   firesTouchEvents?: boolean | null,
 * }} event - keydown 的关键字段。
 * @param {{ coarsePointer: boolean, softKeyboardOpen: boolean }} env - 设备环境。
 * @returns {'pass' | 'line-break'} pass = 交给官方（回车发送）；line-break = 当成 Shift+Enter。
 */
export function classifyEnter(event, env) {
  if (event.key !== 'Enter') return 'pass'
  // 只有触屏主指针的设备才改语义：桌面窄窗口、连了鼠标的平板都保持官方行为。
  if (!env.coarsePointer) return 'pass'
  // IME 候选确认、输入法组合中的回车不能当成换行，也不能当成发送。
  if (event.isComposing === true || event.keyCode === 229) return 'pass'
  // 带修饰键的手势（Shift/Ctrl/Alt/Cmd + Enter）原样交给官方：
  // Shift+Enter 本来就是换行，Ctrl/Cmd+Enter 是官方的加速发送。
  if (event.shiftKey === true || event.altKey === true || event.ctrlKey === true || event.metaKey === true) return 'pass'
  // Chrome 的触摸来源判定是硬件键盘最可靠的正面证据。
  if (event.firesTouchEvents === false) return 'pass'
  if (event.firesTouchEvents === true) return 'line-break'
  return env.softKeyboardOpen ? 'line-break' : 'pass'
}

/**
 * 软键盘是否弹出（用视觉视口与布局视口的落差判断）。
 * @param {Window | null | undefined} view - 目标 window。
 * @returns {boolean} 没有 visualViewport API 时按手机处理（保守取换行）。
 */
export function softKeyboardOpen(view) {
  const visual = view?.visualViewport
  if (!visual) return true
  return view.innerHeight - visual.height > SOFT_KEYBOARD_GAP
}

/**
 * 读 Chrome/Edge 的触摸来源标记；其他引擎没有这个字段。
 * @param {KeyboardEvent} event - keydown 事件。
 * @returns {boolean | null} 未知时为 null。
 */
function firesTouchEvents(event) {
  const caps = event.sourceCapabilities
  return typeof caps?.firesTouchEvents === 'boolean' ? caps.firesTouchEvents : null
}

/**
 * 触屏主指针设备（手机/平板本体），不随窗口宽度变化。
 * @param {Window} view - 目标 window。
 * @returns {boolean} 是否触屏主指针。
 */
function coarsePointer(view) {
  return typeof view.matchMedia === 'function' && view.matchMedia('(pointer: coarse)').matches
}

/**
 * 把裸回车改写成 Shift+Enter：给事件实例遮蔽 shiftKey，下游 keymap 读到的
 * 就是换行手势。不 preventDefault —— 浏览器该插段落还是插段落。
 * @param {KeyboardEvent} event - 原始 keydown。
 * @returns {boolean} true = 改写成功（沿用原生默认行为）。
 */
function rewriteAsShiftEnter(event) {
  try {
    Object.defineProperty(event, 'shiftKey', { configurable: true, value: true })
    return true
  } catch {
    // 事件被冻结时无法改写：拦在 document 捕获阶段，官方 keymap 收不到这次回车，
    // 既不会误发送也不会多插一个换行；用户改用发送键即可。
    event.preventDefault()
    event.stopPropagation()
    return false
  }
}

/**
 * 事件是否发生在 composer 的 contenteditable 里。用 composedPath 兜住 shadow
 * 边界：slot 系统若把编辑器放进 shadow root，事件 target 会被重定向到宿主，
 * 但 composedPath 里仍然能看到真正的编辑节点。
 * @param {KeyboardEvent} event - keydown 事件。
 * @param {Window} view - 目标 window（提供 Element）。
 * @returns {boolean} 是否在 composer 内。
 */
function insideComposer(event, view) {
  const target = event.target
  if (target instanceof view.Element && target.closest?.(COMPOSER_INPUT) != null) return true
  if (typeof event.composedPath !== 'function') return false
  return event.composedPath().some(
    (node) => node instanceof view.Element && node.hasAttribute?.(COMPOSER_INPUT) === true,
  )
}

/**
 * 安装「手机软键盘回车 = 换行」的捕获期监听。
 * @param {Window} [view] - 目标 window（测试可注入）。
 * @returns {() => void} 卸载函数。
 */
export function startMobileEnterKey(view = globalThis.window) {
  if (!view) return () => {}
  const doc = view.document
  const onKeyDown = (event) => {
    if (event.defaultPrevented === true) return
    if (!insideComposer(event, view)) return
    const policy = classifyEnter(
      {
        key: event.key,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        firesTouchEvents: firesTouchEvents(event),
      },
      { coarsePointer: coarsePointer(view), softKeyboardOpen: softKeyboardOpen(view) },
    )
    if (policy !== 'line-break') return
    rewriteAsShiftEnter(event)
  }
  // 捕获阶段：早于 Lexical 挂在编辑器根节点上的 keydown。
  doc.addEventListener('keydown', onKeyDown, true)
  return () => doc.removeEventListener('keydown', onKeyDown, true)
}
