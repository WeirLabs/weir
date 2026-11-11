// Canonical isolated-Desktop UIUX inputs. These are test data only: no product
// dictionary, route, authority, or current-user Case is read or modified.
export const UIUX_VIEWPORTS = Object.freeze([360, 768, 1440])
export const UIUX_SCROLL_CONTAINERS = Object.freeze(['root', 'body', 'decisionPage', 'composer', 'session'])

function assistant(id, zhName, enName, zhStatus, enStatus) {
  return {
    id,
    name: { zh: zhName, en: enName },
    status: { zh: zhStatus, en: enStatus },
    preference: {
      zh: '只根据可以核验的证据回答；遇到高风险或不可逆操作时仍然等待用户明确决定。',
      en: 'Use verifiable evidence and wait for an explicit user decision before high-risk or irreversible operations.',
    },
  }
}

export function createUiuxFixture() {
  return {
    viewports: [...UIUX_VIEWPORTS],
    scrollContainers: [...UIUX_SCROLL_CONTAINERS],
    agents: [
      assistant(
        'uiux-primary',
        '桌面验收主助手 · 用于超长名称与固定底部操作可达性的中文测试数据',
        'Primary Desktop acceptance assistant with an intentionally long bilingual name for wrapping and reachable actions',
        '暂时无法读取或保存决策助手选择。已有页面内容不会被清除。请保留当前页面并稍后重试；这次失败不会确认新的选择、启用自动回答或改变审批与权限边界。若需定位问题，可在高级诊断中查看原始错误。',
        'The decision assistant selection could not be read or saved. Keep this page open and retry when ready; this failure does not confirm a new selection, enable automatic answers, or change approval and permission boundaries. The Advanced diagnostics section retains the original error for troubleshooting.',
      ),
      assistant(
        'uiux-secondary',
        '备用助手 · 用于多个选项独立滚动以及长状态播报的中文测试数据',
        'Secondary keyboard and independent scrolling assistant with a deliberately extended English display name',
        '当前没有可自动回答的范围，新判断仍会询问你；这段额外的长状态用于检查独立滚动区域、状态播报和中英文混合内容，不代表产品已经实现任何新的选择器或自动路由行为，也不会因为文字增多而改变当前有效选择或保存结果。',
        'No automatic answer scope is currently allowed, so a new judgment will still ask you; this additional long status exercises independent scrolling and accessible announcements without claiming that any new selector or automatic routing behavior has shipped.',
      ),
      assistant(
        'uiux-unavailable',
        '不可用助手 · 用于未知状态和错误内容自然换行的中文测试数据',
        'Unavailable assistant for honest unknown status and long error content wrapping checks',
        '状态暂时未知，权威读取尚未完成；请保留当前有效选择并等待真实结果。这个长错误状态只驱动量测，不会伪造加载完成、保存成功、自动回答或任何权威写入，也不会掩盖后续出现的真实错误信息。',
        'Status is temporarily unknown because the authoritative read has not finished; preserve the current valid selection and wait for the real result. This long error state drives measurement only and never fabricates a completed load, successful save, automatic answer, or authoritative write.',
      ),
    ],
    coldContent: {
      zh: Array.from({ length: 16 }, (_, index) => `冷加载中文证据第 ${index + 1} 段：保留输入焦点与草稿，首个成功或错误内容完成布局后才允许一次末尾定位。`),
      en: Array.from({ length: 16 }, (_, index) => `Cold-loaded English evidence paragraph ${index + 1}: preserve the focused input and draft, then allow exactly one end reveal only after the first success or error layout.`),
    },
  }
}
