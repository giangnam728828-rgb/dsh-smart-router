/**
 * lib/log.js — 一行一条的诊断日志。默认关闭，只在 config.debug 为真时写。
 *
 * 刻意做得极简：appendFileSync、单文件、超限就轮转到 `.1`。
 * 一个「只负责提示」的插件，不该因为写日志而卡住用户的回合，
 * 所以这里所有异常都被吞掉 —— 日志失败不算失败。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const MAX_BYTES = 2 * 1024 * 1024

/** 日志路径：$DSH_HOME/smart-router/activity.jsonl（默认 ~/.dsh）。 */
export function logPath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'smart-router', 'activity.jsonl')
}

/** 写一条。绝不抛错，绝不阻塞。 */
export function record(entry) {
  const file = logPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // 文件还不存在 —— 正常
    }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
