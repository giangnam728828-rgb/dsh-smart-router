/**
 * test/client-scope.test.mjs — 浏览器半区的静态检查：不许引用作用域外的变量。
 *
 * 为什么需要它：客户端这半边没有 DOM、没有 React，跑不了渲染测试，
 * 于是一个「函数定义在工厂作用域、却用了组件内部的变量」的 bug 直接进了线上 ——
 * 渲染技能行时抛 ReferenceError，被宿主的 SlotErrorBoundary 兜住，
 * 整块面板换成空 div：表现就是「点了没弹出来」「突然消失」。
 *
 * 这里用 acorn 把 client.js 解析成 AST，自己走一遍作用域链：
 * 任何一个标识符引用，凡是解析不到（既不是声明、也没有外层绑定、也不是全局），
 * 就报错并指出行号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const acorn = require('/root/.dsh/plugin-acorn.cjs')

/** 浏览器与语言内置的名字：不算未定义。 */
const GLOBALS = new Set([
  'React', 'require', 'module', 'exports', 'arguments',
  'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
  'fetch', 'console', 'Intl', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Promise', 'Set', 'Map', 'WeakMap', 'Symbol', 'Error',
  'RegExp', 'Function', 'undefined', 'NaN', 'Infinity', 'globalThis',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'isNaN',
])

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
    walk(node[key], visit)
  }
}

/** 从一个解构/普通模式里收集被声明的名字，并标记这些节点「不是引用」。 */
function declarePattern(pattern, scope, declared) {
  if (pattern === null || typeof pattern !== 'object') return
  switch (pattern.type) {
    case 'Identifier':
      scope.names.add(pattern.name)
      declared.add(pattern)
      return
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        declarePattern(property.type === 'RestElement' ? property.argument : property.value, scope, declared)
      }
      return
    case 'ArrayPattern':
      for (const element of pattern.elements) declarePattern(element, scope, declared)
      return
    case 'AssignmentPattern':
      declarePattern(pattern.left, scope, declared)
      return
    case 'RestElement':
      declarePattern(pattern.argument, scope, declared)
      return
    default:
  }
}

/**
 * 一遍扫描：建立作用域树，记录**每个节点**所在的作用域，登记所有声明。
 *
 * 关键点：变量只能在自己的作用域链上被解析。之前用 Program 作用域去检查整个
 * 文件，等于把所有内层声明都当成不存在 —— 那既漏报又误报。
 */
function analyze(ast) {
  const scopeOfNode = new WeakMap()
  const declared = new WeakSet()      // 声明处的 Identifier，不是引用
  const identifiers = []

  function visit(node, scope) {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, scope)
      return
    }
    if (typeof node.type !== 'string') return

    let current = scope
    const isFunction =
      node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression'
    const createsScope = isFunction
      || node.type === 'BlockStatement'
      || node.type === 'Program'
      || node.type === 'CatchClause'

    if (createsScope) {
      current = { parent: scope, names: new Set() }
      if (isFunction) {
        for (const param of node.params) declarePattern(param, current, declared)
        if (node.id !== null) declarePattern(node.id, current, declared)
      }
      if (node.type === 'CatchClause' && node.param !== null) declarePattern(node.param, current, declared)
      if (node.type === 'BlockStatement') {
        for (const statement of node.body) {
          if (statement.type === 'VariableDeclaration') {
            for (const declarator of statement.declarations) declarePattern(declarator.id, current, declared)
          }
          if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id !== null) {
            declarePattern(statement.id, current, declared)
          }
        }
      }
      if (node.type === 'Program') {
        for (const statement of node.body) {
          if (statement.type === 'VariableDeclaration') {
            for (const declarator of statement.declarations) declarePattern(declarator.id, current, declared)
          }
        }
      }
    }

    scopeOfNode.set(node, current)
    if (node.type === 'Identifier') identifiers.push({ node, scope: current })

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
      const value = node[key]
      if (value === null || typeof value !== 'object') continue
      if (Array.isArray(value)) {
        for (const child of value) visit(child, current)
      } else if (typeof value.type === 'string') {
        visit(value, current)
      }
    }
  }

  visit(ast, { parent: undefined, names: new Set(GLOBALS) })
  return { identifiers, declared }
}

function resolve(scope, name) {
  let current = scope
  while (current !== undefined) {
    if (current.names.has(name)) return true
    current = current.parent
  }
  return GLOBALS.has(name)
}

test('client.js 里没有作用域外的变量引用（会让面板整块崩掉）', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script', locations: true })
  const { identifiers, declared } = analyze(ast)

  // 属性名（a.b 的 b、对象字面量的 key）不是变量引用，先收集再排除
  const propertyKeys = new WeakSet()
  const memberProps = new WeakSet()
  walk(ast, (node) => {
    if ((node.type === 'Property' || node.type === 'MethodDefinition') && node.computed !== true && node.key?.type === 'Identifier') {
      propertyKeys.add(node.key)
    }
    if (node.type === 'MemberExpression' && node.computed !== true && node.property?.type === 'Identifier') {
      memberProps.add(node.property)
    }
  })

  const problems = []
  for (const { node, scope } of identifiers) {
    if (declared.has(node) || propertyKeys.has(node) || memberProps.has(node)) continue
    if (resolve(scope, node.name)) continue
    problems.push(`第 ${node.loc?.start?.line ?? '?'} 行：${node.name}`)
  }

  assert.deepEqual(problems, [], `client.js 引用了作用域外的变量：\n${problems.join('\n')}`)
})

/** 走子树，并标记掉「属性名」这类不是引用的 Identifier。 */
function walkAll(root, visit) {
  const propertyKeys = new WeakSet()
  const memberProps = new WeakSet()
  walk(root, (node) => {
    if (node.type === 'Property' && node.computed !== true && node.key?.type === 'Identifier') {
      propertyKeys.add(node.key)
    }
    if (node.type === 'MemberExpression' && node.computed !== true && node.property?.type === 'Identifier') {
      memberProps.add(node.property)
    }
    if (node.type === 'MethodDefinition' && node.computed !== true && node.key?.type === 'Identifier') {
      propertyKeys.add(node.key)
    }
  })
  walk(root, (node) => {
    if (node.type === 'Identifier' && (propertyKeys.has(node) || memberProps.has(node))) {
      node.__skipped = true
    }
    visit(node)
  })
}