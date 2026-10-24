// Pure function-call metadata: safe to import in the service worker without loading page code.
import type { ToolDeclaration, ToolResult } from './contracts'

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number }
const string = (maxLength = 512): Schema => ({ type: 'string', maxLength })
const boolean: Schema = { type: 'boolean' }
const resume = { resumeName: string(), resumeIndex: { type: ['integer', 'null'], minimum: 0, maximum: 99 } as Schema }
const thread = { company: string(), jobTitle: string(), job_title: string() }
const object = (properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false })
const parameterSchemas: Record<string, Schema> = {
  open_search: object({ keyword: string(), cityCode: string(32), page: { type: 'integer', minimum: 1, maximum: 10000 } }, ['keyword']),
  scan_jobs: object({ withDetail: boolean, offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  read_job_detail: object({ jobId: string() }, ['jobId']),
  apply_job: object({ jobId: string() }, ['jobId']),
  select_filters: object({ filters: { type: 'array', minItems: 1, maxItems: 20, items: object({ group: { ...string(), minLength: 1 }, option: { ...string(), minLength: 1 } }, ['group', 'option']) } }, ['filters']),
  open_thread: object(thread, ['company']),
  read_thread_header: object(thread, ['company']),
  delete_thread: object(thread, ['company']),
  click_card: object({ kind: { type: 'string', enum: ['resume_request', 'location_confirm', 'contact_exchange'] }, accept: boolean, ...resume }, ['kind', 'accept']),
  send_message: object({ text: string(20000) }, ['text']),
  send_resume: object(resume),
  reload_page: object({ force: boolean }),
  probe_dom: object({ selector: string(2048), depth: { type: 'integer', minimum: 0, maximum: 4 } }),
  probe_row: object({ company: string() }),
}

export const TOOL_CATALOG: ToolDeclaration[] = [
  { name: 'list_threads', description: '列出左侧会话（HR 名/公司/未读；岗位名与薪资列表行没有，需 read_thread_header）', irreversible: false, parameters: parameterSchemas.list_threads || object() },
  { name: 'read_messages', description: '读当前打开会话的消息（区分 hr/me/system，卡片带类型）', irreversible: false, parameters: parameterSchemas.read_messages || object() },
  { name: 'list_pending_cards', description: '列出当前会话里待处理的交互卡片类型（不点击）', irreversible: false, parameters: parameterSchemas.list_pending_cards || object() },
  { name: 'open_thread', description: '打开指定会话（公司名必填，岗位名可选）；不在聊天页时先跳转聊天页', irreversible: false, parameters: parameterSchemas.open_thread || object() },
  { name: 'click_card', description: '点一张待处理卡片的同意/拒绝（kind=resume_request|location_confirm|contact_exchange，accept=bool；同意索要简历时会走完发简历流程）', irreversible: true, parameters: parameterSchemas.click_card || object() },
  { name: 'send_message', description: '给当前会话发一条文本（不可撤回）', irreversible: true, parameters: parameterSchemas.send_message || object() },
  { name: 'send_resume', description: '给当前会话发附件简历（resumeName 可选；不可撤回）', irreversible: true, parameters: parameterSchemas.send_resume || object() },
  { name: 'delete_thread', description: '删除指定会话（company 必填；不可撤回）', irreversible: true, parameters: parameterSchemas.delete_thread || object() },
  { name: 'scan_jobs', description: '扫描当前职位列表页。offset 从 0 起，limit=1..100；withDetail=true 时默认且最多 10 条，返回有效 limit 和 total/hasMore/nextOffset，用 nextOffset 继续读取。无明细且未传 limit 时保留整页列表。', irreversible: false, parameters: parameterSchemas.scan_jobs || object() },
  { name: 'read_filters', description: '读取搜索页筛选条件（分组 + 可选值 + 当前选中）', irreversible: false, parameters: parameterSchemas.read_filters || object() },
  { name: 'select_filters', description: '按「分组 → 选项」点选筛选项（如 工作经验=3-5年），可传多个', irreversible: true, parameters: parameterSchemas.select_filters || object() },
  { name: 'get_page_state', description: '当前页面状态：网址、是否聊天页、当前打开会话（公司/岗位/薪资/城市）', irreversible: false, parameters: parameterSchemas.get_page_state || object() },
  { name: 'open_search', description: '打开职位搜索页（keyword 必填，cityCode 可选；保留当前筛选条件；会跳转页面）', irreversible: false, parameters: parameterSchemas.open_search || object() },
  { name: 'read_job_detail', description: '读指定岗位的 JD 全文（只切换详情面板，不投递）', irreversible: false, parameters: parameterSchemas.read_job_detail || object() },
  { name: 'apply_job', description: '对指定岗位点「立即沟通」投递（jobId 必填，不可撤回；会记账）', irreversible: true, parameters: parameterSchemas.apply_job || object() },
  { name: 'probe_overlays', description: '读当前可见浮层/弹窗结构（标签链、尺寸、文本长度、是否有 iframe），用于适配选择器', irreversible: false, parameters: parameterSchemas.probe_overlays || object() },
  { name: 'probe_dom', description: '读指定选择器的 DOM 结构（标签/class/role/按钮文案与禁用态/文本长度），用于适配选择器', irreversible: false, parameters: parameterSchemas.probe_dom || object() },
  { name: 'probe_row', description: '读某一会话行的组件数据结构（键名与短字符串值），用于适配岗位名/薪资字段', irreversible: false, parameters: parameterSchemas.probe_row || object() },
  { name: 'read_thread_header', description: '读某一会话的头部信息（HR 名/公司/岗位名/薪资/城市）；不在该会话时会先打开', irreversible: false, parameters: parameterSchemas.read_thread_header || object() },
  { name: 'reload_page', description: '刷新当前页面；执行结果持久化后才刷新', irreversible: false, parameters: parameterSchemas.reload_page || object() },
  { name: 'list_tools', description: '列出当前可用工具及其参数', irreversible: false, parameters: parameterSchemas.list_tools || object() },
 ]

export function toolCatalog(): ToolDeclaration[] {
  return structuredClone(TOOL_CATALOG)
}

function matches(value: unknown, schema: Schema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (value === null) return types.includes('null')
  if (schema.enum && !schema.enum.includes(value)) return false
  if (types.includes('object')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const proto = Object.getPrototypeOf(value)
    if (proto !== null && proto !== Object.prototype) return false
    const record = value as Record<string, unknown>
    if (schema.required?.some((key) => !Object.hasOwn(record, key))) return false
    return Object.entries(record).every(([key, entry]) => {
      const property = schema.properties?.[key]
      return property ? matches(entry, property) : schema.additionalProperties !== false
    })
  }
  if (types.includes('array')) {
    if (!Array.isArray(value)) return false
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false
    return !schema.items || value.every((item) => matches(item, schema.items!))
  }
  if (types.includes('string')) return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity)
  if (types.includes('boolean')) return typeof value === 'boolean'
  if (types.includes('integer')) return typeof value === 'number' && Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)
  return false
}

const requiredErrors: Record<string, string> = { text: 'text_required', keyword: 'keyword_required', company: 'company_required', jobId: 'jobId_required', kind: 'kind_required', filters: 'filters_required' }

/** Fail before any DOM work. Preserve legacy missing-argument errors; never coerce malformed inputs. */
export function validateToolArgs(name: string, args: unknown): ToolResult {
  const declaration = TOOL_CATALOG.find((tool) => tool.name === name)
  if (!declaration) return { ok: false, error: 'unknown_tool' }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'invalid_arguments' }
  const schema = declaration.parameters as Schema
  for (const key of schema.required || []) {
    const value = (args as Record<string, unknown>)[key]
    if ((value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) && requiredErrors[key]) {
      return { ok: false, error: requiredErrors[key] }
    }
  }
  return matches(args, schema) ? { ok: true } : { ok: false, error: 'invalid_arguments' }
}
