// 移动端文件辅助（issue #17）。早期 dsh-web 在手机上点「文件链接」会触发桌面端
// workspaces.openPath(open <path>)，既打不开（文件在电脑上）又会抛
// "path open failed"，所以这里曾在捕获阶段拦下这类激活，弹一句「无法直接打开」的提示。
//
// 现在 DSH 的文件链接改走 openFile：点击由 ui-primitives 的 MarkdownDelegate /
// ToolCard 交给 chat inject，最终在**侧边栏**里打开预览
// （ui-tool/tests/toolview-slot.client.spec.tsx:223「file-path clicks travel owner
// openFile → chat inject → the right Sidebar」），不再调主机 openPath，也不会失败。
// 于是那层拦截连同提示文案一起删掉了：它已经过时，而且因为它靠「文案像不像路径」
// 猜目标，会把文案恰好是路径的正常按钮一起吞掉，点了没反应。
//
// 保留两件事：
//   1) 在每个文件链接旁注入一个「复制」按钮，点它经主机 RPC 读文件正文再写剪贴板；
//   2) 隐藏「添加工作区」入口（手机上配工作区无意义）。
//
// 识别方式：不依赖 dsh-web 的 hash 类名（每次构建都变），只认「文本像文件路径的
// <button>/<a>」——文件链接按钮的文案就是路径（如 lib/proxy.mjs / /Users/.../x.ts）。

/** 「添加工作区」入口的文案（随语言变化），两种都覆盖。 */
const WS_LABELS = ['添加工作区', '添加工作区…', 'Add workspace', 'Add workspace…']
/** 复制按钮文案。 */
const COPY_LABEL = '复制'

/** 主机 fileRead 回调返回结构（与 client/api.js 的 FileReadResult 对齐）。 */
interface ReadFileResponse {
  ok: boolean;
  value?: { content: string; path: string; size: number };
  error?: { message: string };
}

/** 文本是否像文件路径：绝对路径 / 相对路径 / 带扩展名的目录路径。 */
function looksLikeFilePath(text: string | null): boolean {
  const t = (text ?? '').trim()
  if (t.length < 3 || t.length > 320) return false
  if (/^(\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(t)) return true
  if (/\/[\w.\-]+\.\w{1,12}$/.test(t)) return true
  if (/[\w.\-]+\/[\w.\-]+\.\w{1,12}/.test(t)) return true
  return false
}

/** 写剪贴板：优先 navigator.clipboard，非安全上下文（局域网 http）回退 execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 回退 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const okCopy = document.execCommand('copy')
    ta.remove()
    return okCopy
  } catch {
    return false
  }
}

export function startFileGuard(
  readFile: (path: string) => Promise<ReadFileResponse>,
): () => void {
  // 轻量 toast：自包含，不依赖 dsh-pocket 面板的 React 状态。
  let toastEl: HTMLElement | null = null
  let toastTimer: number | null = null
  const showToast = (text: string): void => {
    if (toastEl === null) {
      toastEl = document.createElement('div')
      toastEl.setAttribute('data-mobile-nav', 'file-guard-toast')
      Object.assign(toastEl.style, {
        position: 'fixed',
        left: '50%',
        bottom: '64px',
        transform: 'translateX(-50%)',
        maxWidth: '84vw',
        zIndex: '9999',
        padding: '10px 14px',
        borderRadius: '10px',
        background: 'rgba(20,22,28,.92)',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.4',
        textAlign: 'center',
        fontFamily: 'inherit',
        boxShadow: '0 4px 16px rgba(0,0,0,.28)',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity .18s ease',
      } as CSSStyleDeclaration)
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = text
    requestAnimationFrame(() => {
      if (toastEl !== null) toastEl.style.opacity = '1'
    })
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      if (toastEl !== null) toastEl.style.opacity = '0'
    }, 2600)
  }

  // 在文件链接旁注入「复制」按钮：点它经主机 RPC 读文件正文再写剪贴板。
  // 用 data-mobile-nav-copy 标记已处理的链接，避免重复注入；React 重渲染会
  // 产生新元素（无标记），MutationObserver 重新补上按钮。
  const injectCopyButtons = (): void => {
    const links = document.querySelectorAll('button, a')
    links.forEach((el) => {
      if (el.getAttribute('data-mobile-nav-copy') === '1') return
      const txt = (el.textContent ?? '').trim()
      if (!looksLikeFilePath(txt)) return
      el.setAttribute('data-mobile-nav-copy', '1')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('data-mobile-nav', 'copy-file')
      btn.textContent = COPY_LABEL
      btn.addEventListener('click', async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const filePath = (el.textContent ?? '').trim()
        btn.disabled = true
        btn.textContent = '…'
        try {
          const res = await readFile(filePath)
          if (!res?.ok) {
            showToast(res?.error?.message ?? '复制失败')
            return
          }
          const content = res.value?.content ?? ''
          const copied = await copyText(content)
          if (copied) {
            const kb = Math.max(1, Math.round((res.value?.size ?? content.length) / 1024))
            showToast(`已复制文件内容（${kb} KB）`)
          } else {
            showToast('复制失败，请手动选择')
          }
        } catch (err) {
          showToast(err instanceof Error ? err.message : '复制失败')
        } finally {
          btn.disabled = false
          btn.textContent = COPY_LABEL
        }
      })
      el.parentElement?.insertBefore(btn, el.nextSibling)
    })
  }
  injectCopyButtons()
  const copyObserver = new MutationObserver(() => injectCopyButtons())
  copyObserver.observe(document.body, { childList: true, subtree: true })

  // 隐藏「添加工作区」入口：图标按钮由 mobile.css.ts 按 aria-label 隐藏；
  // 下拉菜单里的文本项 CSS 选不到，这里按文案兜底（只在新增节点时检查，省开销）。
  const hideWsEntries = (): (() => void) => {
    const checkOne = (node: Node): void => {
      if (node.nodeType !== 1) return
      const el = node as HTMLElement
      const txt = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
      if (WS_LABELS.includes(txt)) {
        el.style.display = 'none'
        el.setAttribute('data-mobile-nav-hide', 'add-workspace')
      }
    }
    const sel = '[role="menuitem"],[role="option"],li,button,a'
    document.querySelectorAll(sel).forEach(checkOne)
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return
          checkOne(n)
          ;(n as HTMLElement).querySelectorAll?.(sel).forEach(checkOne)
        })
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }
  const disconnectWs = hideWsEntries()

  return () => {
    copyObserver.disconnect()
    disconnectWs()
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastEl?.remove()
  }
}
