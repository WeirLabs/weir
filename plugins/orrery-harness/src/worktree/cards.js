// User-facing copy of the three decision cards (merge approval, post-merge
// cleanup, abandon) in the user's GUI language. These cards are UI for the
// human, not model templates: the model only ever sees the English tool
// result. The language comes from the browser (the lanes view request carries
// it); without one the cards fall back to English. Option labels are compared
// back by the same copy object, so a card is always answered in its own
// language. Paths are shown repository-relative so long absolute paths never
// overflow the card. Pure module.

/** @typedef {'en' | 'zh'} CardLocale */

/** @param {unknown} value @returns {CardLocale} */
export function cardLocale(value) {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** Repository-relative display path ('/'-separated). @param {string} path @param {string} [root] */
export function displayPath(path, root) {
  if (!root || typeof path !== 'string') return path
  const normalized = path.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized
}

const COPY = {
  en: {
    mergeHeader: 'Worktree merge',
    mergeQuestion: (/** @type {string} */ title, /** @type {string} */ base) => `Merge lane "${title}" into ${base}?`,
    mergeOption: (/** @type {string} */ base) => `Merge into ${base} (--no-ff)`,
    mergeOptionDescription: (/** @type {string} */ branch) => `--no-ff merge of ${branch}`,
    notNow: 'Not now',
    notNowDescription: 'Keep the lane as it is',
    cleanupHeader: 'Worktree cleanup',
    cleanupQuestion: (/** @type {string} */ title) => `Lane "${title}" is merged. What should happen to its worktree?`,
    keep: 'Keep worktree',
    removeWorktree: 'Remove worktree',
    removeAll: 'Remove worktree and branch',
    cleanupDescriptions: { keep: 'Leave the worktree and branch in place', worktree: 'Remove the worktree, keep the branch', all: 'Remove the worktree and delete the merged branch' },
    abandonHeader: 'Abandon lane',
    abandonQuestion: (/** @type {string} */ title) => `Abandon lane "${title}"?`,
    cancel: 'Cancel',
    abandonDescriptions: {
      keep: 'Abandon, but leave the worktree and branch',
      worktree: 'Abandon and remove the worktree, keep the branch',
      all: (/** @type {number} */ unmerged) => (unmerged > 0 ? `Abandon and delete everything, including ${unmerged} unmerged commit(s)` : 'Abandon and delete the worktree and branch'),
      cancel: 'Keep the lane active',
    },
    lane: 'Lane', branch: 'Branch', changes: 'Changes', files: 'file(s)', precheck: 'Conflict precheck', clean: 'clean',
    verification: 'Verification', verificationOff: 'Verification: not enabled for this repository', commits: 'Commits',
    fullDiff: 'The full diff is in the Worktrees panel.',
    merged: (/** @type {string} */ branch, /** @type {string} */ base) => `\`${branch}\` was merged into \`${base}\``,
    worktree: 'Worktree', scratch: 'Lane scratch notes (.orrery) are copied into the main repository before anything is removed.',
    abandonLine: (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ state) => `Abandon lane \`${id}\` — ${title} (state ${state}).`,
    unmergedLost: (/** @type {number} */ count, /** @type {string} */ branch) => `**${count} unmerged commit(s)** on \`${branch}\` will be lost if the branch is removed.`,
    noUnmerged: (/** @type {string} */ branch) => `\`${branch}\` has no unmerged commits.`,
  },
  zh: {
    mergeHeader: 'Worktree 合并',
    mergeQuestion: (/** @type {string} */ title, /** @type {string} */ base) => `将车道「${title}」合并到 ${base}？`,
    mergeOption: (/** @type {string} */ base) => `合并到 ${base}（--no-ff）`,
    mergeOptionDescription: (/** @type {string} */ branch) => `以 --no-ff 合并 ${branch}`,
    notNow: '暂不合并',
    notNowDescription: '保持车道现状',
    cleanupHeader: 'Worktree 收尾',
    cleanupQuestion: (/** @type {string} */ title) => `车道「${title}」已合并。如何处理它的 worktree？`,
    keep: '保留 worktree',
    removeWorktree: '清理 worktree',
    removeAll: '清理 worktree 和分支',
    cleanupDescriptions: { keep: '保留 worktree 与分支', worktree: '删除 worktree，保留分支', all: '删除 worktree 并删除已合并的分支' },
    abandonHeader: '放弃车道',
    abandonQuestion: (/** @type {string} */ title) => `放弃车道「${title}」？`,
    cancel: '取消',
    abandonDescriptions: {
      keep: '放弃，但保留 worktree 与分支',
      worktree: '放弃并删除 worktree，保留分支',
      all: (/** @type {number} */ unmerged) => (unmerged > 0 ? `放弃并全部删除，包括 ${unmerged} 个未合并提交` : '放弃并删除 worktree 与分支'),
      cancel: '保持车道活跃',
    },
    lane: '车道', branch: '分支', changes: '改动', files: '个文件', precheck: '冲突预检', clean: '无冲突',
    verification: '验证', verificationOff: '验证：本仓库未启用', commits: '提交',
    fullDiff: '完整 diff 见 Worktrees 面板。',
    merged: (/** @type {string} */ branch, /** @type {string} */ base) => `\`${branch}\` 已合并到 \`${base}\``,
    worktree: 'Worktree', scratch: '删除前会先把车道中的 .orrery 笔记复制回主仓库。',
    abandonLine: (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ state) => `放弃车道 \`${id}\` —— ${title}（状态 ${state}）。`,
    unmergedLost: (/** @type {number} */ count, /** @type {string} */ branch) => `删除分支将**永久丢失** \`${branch}\` 上的 **${count} 个未合并提交**。`,
    noUnmerged: (/** @type {string} */ branch) => `\`${branch}\` 没有未合并的提交。`,
  },
}

/** @param {CardLocale} locale */
export function cardCopy(locale) {
  const copy = COPY[locale] ?? COPY.en
  return {
    ...copy,
    /** Cleanup / abandon choice labels keyed by mode. */
    choices: { keep: copy.keep, worktree: copy.removeWorktree, all: copy.removeAll },
    /**
     * @param {{ lane: any, commits: Array<{ sha: string, subject: string }>, stat: { files: number, added: number, removed: number }, verification: any }} input
     */
    mergeDetail({ lane, commits, stat, verification }) {
      // GFM list items: a single \n is a soft break and would collapse every
      // fact into one paragraph, so each fact is its own `- ` line.
      return [
        `- **${copy.lane}** \`${lane.id}\` — ${lane.title}`,
        `- **${copy.branch}** \`${lane.branch}\` → \`${lane.base.branch}\``,
        `- **${copy.changes}** ${stat.files} ${copy.files}, +${stat.added} −${stat.removed}`,
        `- **${copy.precheck}** ${copy.clean}`,
        verification?.enabled
          ? `- **${copy.verification}** ${verification.results.map((/** @type {any} */ result) => `${result.name} ${result.exit === 0 ? '✓' : `✗ (exit ${result.exit})`}`).join(', ')}`
          : `- ${copy.verificationOff}`,
        '',
        `**${copy.commits}** (${commits.length}${commits.length >= 20 ? '+' : ''})`,
        ...commits.map((commit) => `  - \`${commit.sha}\` ${commit.subject}`),
        '',
        `*${copy.fullDiff}*`,
      ].join('\n')
    },
    /** @param {any} lane @param {{ files: number, added: number, removed: number }} stat @param {string} [root] */
    cleanupDetail(lane, stat, root) {
      return [
        `- ${copy.merged(lane.branch, lane.base.branch)} (${stat.files} ${copy.files}, +${stat.added} −${stat.removed}).`,
        `- ${copy.worktree}: \`${displayPath(lane.path, root)}\``,
        `- ${copy.scratch}`,
      ].join('\n')
    },
    /** @param {any} lane @param {number} unmerged @param {string} [root] */
    abandonDetail(lane, unmerged, root) {
      return [
        `- ${copy.abandonLine(lane.id, lane.title, lane.state)}`,
        `- ${copy.worktree}: \`${displayPath(lane.path, root)}\``,
        '',
        // The unmerged-commit warning stays its own paragraph for emphasis.
        unmerged > 0 ? copy.unmergedLost(unmerged, lane.branch) : copy.noUnmerged(lane.branch),
      ].join('\n')
    },
  }
}
