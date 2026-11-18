/**
 * test/_env.mjs — 每个跑 `apply()` 的测试文件先导入这个。
 *
 * 为什么要有它：`record()` 会把日志写到 `$DSH_HOME/smart-router/activity.jsonl`。
 * 测试里不设 DSH_HOME，就会写进用户**真实的**日志文件 —— 排查线上问题时，
 * 日志里混着一堆「同一秒里 loaded 五次」的测试痕迹，人是读不出来的。
 *
 * logPath() 是在 record() 被调用的那一刻读环境变量，所以在这里改就够。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.DSH_SMART_ROUTER_TEST_HOME === undefined) {
  process.env.DSH_SMART_ROUTER_TEST_HOME = mkdtempSync(join(tmpdir(), 'smart-router-test-'))
}
process.env.DSH_HOME = process.env.DSH_SMART_ROUTER_TEST_HOME

export const TEST_HOME = process.env.DSH_SMART_ROUTER_TEST_HOME
