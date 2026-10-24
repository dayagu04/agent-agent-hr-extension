export interface ResumeField { key: string; label: string; value: string }
export interface ResumeRecord { id: string; fields: ResumeField[] }
export interface ResumeSection { key: string; title: string; records: ResumeRecord[] }

/** A page-local draft: edits never mutate the server snapshot or another tab. */
export function createResumeDraft(sections: ResumeSection[]): ResumeSection[] {
  return sections.map((section) => ({ ...section, records: section.records.map((record) => ({
    ...record, fields: record.fields.map((field) => ({ ...field })),
  })) }));
}

export function editResumeDraft(sections: ResumeSection[], section: number, record: number, field: number, value: string): boolean {
  if (![section, record, field].every((index) => Number.isInteger(index) && index >= 0) || value.length > 4000) return false;
  const target = sections[section]?.records[record]?.fields[field];
  if (!target) return false;
  target.value = value;
  return true;
}
type FieldSpec = [key: string, label: string, aliases?: string[], merge?: string[]];

const COMMON_DATES: FieldSpec[] = [
  ["start", "开始时间", ["开始日期", "起始时间", "起始日期", "入学时间", "入职时间", "start date", "from"], ["start_month", "start_date"]],
  ["end", "结束时间", ["结束日期", "截止时间", "毕业时间", "预计毕业时间", "离职时间", "end date", "to"], ["end_month", "end_date"]],
];
export const RESUME_FIELDS: Record<string, FieldSpec[]> = {
  basic: [
    ["name", "姓名", ["中文姓名", "真实姓名", "full name", "name"], ["legal_name_zh"]],
    ["phone", "手机号", ["手机", "手机号码", "联系电话", "联系电话号码", "mobile", "phone", "tel"], ["mobile_number"]],
    ["email", "邮箱", ["个人邮箱", "电子邮件", "电子邮箱", "联系邮箱", "email", "e-mail", "email address"], ["contact_email"]],
    ["gender", "性别", ["gender", "sex"]], ["birth_date", "出生日期", ["出生年月", "生日", "birthday", "date of birth"]],
    ["residence_country", "现居国家", ["当前所在国家", "当前居住国家/地区", "国家/地区", "current country"]],
    ["residence_province", "现居省份", ["当前所在省份"]],
    ["residence_city", "现居城市", ["当前所在省市", "当前居住省/市", "所在城市", "当前城市", "居住城市", "现居地", "current city", "current location"]],
    ["nationality", "国籍", ["nationality"]], ["ethnicity", "民族"], ["native_place", "籍贯"],
    ["political_status", "政治面貌"], ["hukou_location", "户籍所在地", ["户口所在地", "户籍地"]],
    ["contact_address", "通讯地址", ["通信地址", "联系地址", "详细地址", "address"]],
    ["personal_summary", "自我评价", ["个人简介", "个人优势", "自我介绍", "自我描述", "个人总结", "自我评价或其他补充信息", "summary", "about yourself"]],
  ],
  educations: [
    ["school", "学校名称", ["学校", "院校", "毕业院校", "school", "university", "institution"], ["school_name"]],
    ["college", "学院名称", ["学院", "院系", "院系名称", "所属院系", "college", "department"]],
    ["major", "专业名称", ["专业", "所学专业", "major", "field of study"]],
    ["degree", "学历", ["学历层次", "education level", "degree"], ["education_level"]],
    ["academic_degree", "学位", [], ["degree"]], ...COMMON_DATES,
    ["gpa", "GPA", ["绩点", "平均绩点"], ["gpa_value"]], ["rank", "成绩排名", ["专业排名", "排名"]],
    ["is_full_time", "是否全日制", ["全日制"]],
    ["description", "在校经历", ["教育描述", "教育经历描述", "主修课程", "补充说明"], ["education_description", "core_courses", "course_summary", "research_direction", "thesis_title"]],
  ],
  employments: [
    ["company", "公司名称", ["公司", "单位名称", "单位", "工作单位", "实习单位", "实习公司", "company", "employer", "organization"], ["employer_name"]],
    ["role", "职位名称", ["职位", "岗位", "职务", "岗位名称", "工作职位", "实习职位", "position", "job title", "role"], ["job_title"]],
    ["employment_kind", "工作类型", ["雇佣类型", "employment type"]],
    ["department", "部门", ["所在部门", "部门名称"]], ...COMMON_DATES, ["location", "工作地点", ["地点", "城市", "location"]],
    ["description", "工作内容", ["描述", "工作描述", "实习内容", "实习描述", "经历描述", "主要职责", "职责描述", "职责与业绩", "工作业绩", "description", "responsibilities"], ["responsibilities", "achievements", "skills_used"]],
  ],
  projects: [
    ["name", "项目名称", ["项目", "project name", "name"]],
    ["role", "担任角色", ["项目角色", "担任职务", "职位", "role"], ["role_title"]], ...COMMON_DATES,
    ["description", "项目描述", ["描述", "项目内容", "项目介绍", "项目职责", "项目成果", "项目经验描述", "职责描述", "description"], ["background", "objective", "responsibilities", "methods", "tools_technologies", "deliverables", "results"]],
    ["url", "项目链接", ["项目地址", "作品链接", "project url", "url"], ["project_url", "repository_url", "demo_url"]],
  ],
  campus: [
    ["name", "组织名称", ["社团名称", "学校组织", "活动名称", "组织", "name"], ["organization_name", "event_name"]],
    ["role", "担任职务", ["职位", "职务", "role"], ["role_title"]], ...COMMON_DATES,
    ["description", "经历描述", ["校园经历描述", "活动描述", "活动内容", "职责描述", "description"], ["responsibilities", "contributions", "results"]],
  ],
  practices: [
    ["name", "实践名称", ["组织名称", "实践单位", "单位名称", "name"], ["organization_name", "program_name"]],
    ["role", "担任职务", ["职务", "role"], ["role_title"]], ...COMMON_DATES,
    ["description", "实践描述", ["实践内容", "职责描述", "description"], ["tasks", "contributions", "outcomes"]],
  ],
  awards: [["name", "奖项名称", ["奖项", "奖励名称", "荣誉名称", "获奖名称", "name"]], ["date", "获奖时间", ["获奖日期", "日期", "date"]], ["level", "获奖级别", ["级别"]], ["description", "奖项描述", ["描述", "description"]]],
  certificates: [["name", "证书名称", ["证书", "资格证书", "name"]], ["date", "获得时间", ["获取日期", "颁发日期", "date"], ["issued_date"]], ["score", "成绩", ["分数", "score"]]],
  languages: [["name", "语种", ["语言", "语言名称", "name"]], ["exam_name", "语言水平", ["考试名称", "外语水平", "英语水平"]], ["score", "成绩", ["分数", "score"]]],
  skills: [["name", "技能名称", ["技能", "专业技能", "技术栈", "skills", "name"]], ["proficiency", "掌握程度", ["熟练程度", "熟练度"]]],
  links: [["platform", "平台", ["平台名称"]], ["url", "个人主页", ["个人网站", "网站", "作品集链接", "github", "portfolio", "url"]]],
};

const SECTION_SPECS = [
  ["basic", "个人信息", "basic"], ["educations", "教育经历", "educations"],
  ["internships", "实习经历", "employments"], ["work", "工作经历", "employments"],
  ["projects", "项目经历", "projects"], ["campus", "校园经历", "campusActivities"],
  ["practices", "实践经历", "practices"], ["skills", "专业技能", "skills"],
  ["awards", "获奖荣誉", "awards"], ["certificates", "证书", "certificates"],
  ["languages", "语言能力", "languages"], ["links", "个人链接", "links"],
] as const;

export function fieldSpecs(section: string): FieldSpec[] {
  return RESUME_FIELDS[section === "internships" || section === "work" || section === "experience" ? "employments" : section] ?? [];
}

/** Only known, server-validated facts are exposed to the page. No attachment text. */
export function buildResumeSections(raw: Record<string, unknown>): ResumeSection[] {
  return SECTION_SPECS.flatMap(([key, title, source]) => {
    const value = raw[source];
    const records = key === "basic" ? [value ?? {}] : Array.isArray(value) ? value : [];
    if (records.length > 100) throw new Error("网申资料记录过多。");
    const entries = records.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("网申资料格式无效。");
      const row = item as Record<string, unknown>;
      if (key !== "basic" && (typeof row.recordId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(row.recordId))) throw new Error("网申资料记录标识无效。");
      const internship = /实习|intern/i.test(String(row.employment_kind ?? ""));
      if (key === "internships" && !internship || key === "work" && internship) return [];
      const fields = fieldSpecs(key).flatMap(([field, label, , merge]) => {
        const values = (merge ?? [field]).map((name) => {
          const text = row[name];
          if (text === undefined) return "";
          if (typeof text !== "string" || text.length > 4000) throw new Error("网申资料字段格式无效。");
          return text.trim();
        }).filter(Boolean);
        // Date and URL alternatives are aliases, not paragraphs.
        const value = ["start", "end", "url"].includes(field) ? values[0] ?? "" : [...new Set(values)].join("\n");
        return value ? [{ key: field, label, value }] : [];
      });
      return fields.length ? [{ id: String(row.recordId ?? "basic"), fields }] : [];
    });
    return entries.length ? [{ key, title, records: entries }] : [];
  });
}

export function normalizedLabel(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/^(请输入|请选择|请填写|please enter|please select)\s*/i, "")
    .replace(/\(.*?\)|（.*?）/g, "").replace(/必填|选填|required|optional/g, "").replace(/[\s\p{P}\p{S}]/gu, "");
}

export function fieldKey(section: string, label: string): string | undefined {
  const normalized = normalizedLabel(label);
  if (!normalized) return;
  const specs = fieldSpecs(section);
  const exact = specs.filter(([, text, aliases = []]) => [text, ...aliases].some((alias) => normalizedLabel(alias) === normalized));
  if (exact.length === 1) return exact[0][0];
  // Prefix/suffix labels such as “项目开始时间” still refer to the same field.
  const partial = specs.filter(([, text, aliases = []]) => [text, ...aliases].some((alias) => {
    const target = normalizedLabel(alias);
    return target.length >= 4 && normalized.includes(target);
  }));
  return partial.length === 1 ? partial[0][0] : undefined;
}

export function sectionKey(text: string): string | undefined {
  const value = normalizedLabel(text);
  if (value.length > 65) return;
  if (/个人信息|基本信息|基础信息|联系信息|联系方式|personalinformation|basicinformation/.test(value)) return "basic";
  if (/教育经历|教育背景|学历信息|education|academic/.test(value) || value === "学历") return "educations";
  if (/实习.*工作|工作.*实习|工作实践|employment|workexperience/.test(value)) return "experience";
  if (/实习|internship/.test(value)) return "internships";
  if (/工作经历|工作经验|任职经历|职业经历/.test(value) || value === "work") return "work";
  if (/项目经历|项目经验|科研经历/.test(value) || /^projects?$/.test(value)) return "projects";
  if (/校园|校内|社团|学生工作/.test(value)) return "campus";
  if (/实践|志愿|公益/.test(value)) return "practices";
  if (/获奖|荣誉|奖项|award/.test(value)) return "awards";
  if (/证书|资格证|certificate/.test(value)) return "certificates";
  if (/语言|外语|language/.test(value)) return "languages";
  if (/技能|skill/.test(value)) return "skills";
  if (/个人链接|个人主页|作品集/.test(value)) return "links";
}

export function sectionRecords(sections: ResumeSection[], key: string): ResumeRecord[] {
  return key === "experience" ? sections.filter((section) => ["internships", "work"].includes(section.key)).flatMap((section) => section.records)
    : sections.find((section) => section.key === key)?.records ?? [];
}

export function highestEducation(sections: ResumeSection[]): ResumeRecord | undefined {
  const rank = (record: ResumeRecord) => {
    const value = record.fields.find((field) => field.key === "degree")?.value ?? "";
    return /博士|doctor|phd/i.test(value) ? 5 : /硕士|研究生|master/i.test(value) ? 4 : /本科|学士|bachelor/i.test(value) ? 3 : /大专|专科/i.test(value) ? 2 : 1;
  };
  return [...sectionRecords(sections, "educations")].sort((a, b) => rank(b) - rank(a))[0];
}
