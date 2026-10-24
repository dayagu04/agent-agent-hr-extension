export type RecruitmentPageKind = "job_detail" | "application_form";

export interface RecruitmentPageDetection {
  detected: boolean;
  adapterId: "moka" | "beisen" | "bytedance" | "tencent" | "alibaba" | null;
  kind: RecruitmentPageKind | null;
  reason: "unsupported_host" | "application_route" | "job_route" | "recruitment_title" | "unknown_route";
}

interface PageClassificationInput {
  url: string;
  title?: string;
}

const HOSTS: Array<{
  id: Exclude<RecruitmentPageDetection["adapterId"], null>;
  matches: (hostname: string) => boolean;
}> = [
  { id: "moka", matches: (hostname) => hostname === "mokahr.com" || hostname.endsWith(".mokahr.com") },
  { id: "beisen", matches: (hostname) => hostname === "zhiye.com" || hostname.endsWith(".zhiye.com") || hostname === "we.zyt.com" },
  {
    id: "bytedance",
    matches: (hostname) => ["jobs.bytedance.com", "joinbytedance.com"].some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    ),
  },
  { id: "tencent", matches: (hostname) => ["join.qq.com", "campus.tencent.com"].includes(hostname) },
  { id: "alibaba", matches: (hostname) => ["talent.alibaba.com", "campus.alibaba.com"].includes(hostname) },
];

const APPLICATION_ROUTE = /(?:^|[\/#_.-])(?:apply|application|candidate|resume|deliver|submission)(?:$|[\/#?_.-])/i;
const JOB_ROUTE = /(?:^|[\/#_.-])(?:job|jobs|position|positions|career|careers|recruit|recruitment|campus|campus_apply|social_recruitment|search)(?:$|[\/#?_.-])/i;
const RECRUITMENT_TITLE = /(?:招聘|职位|岗位|网申|求职|申请|career|careers|job|jobs|position|apply)/i;

export function supportedAtsAdapter(url: string): RecruitmentPageDetection["adapterId"] {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const hostname = parsed.hostname.toLowerCase();
    return HOSTS.find((item) => item.matches(hostname))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Classifies only URL, route and document title metadata. It deliberately does
 * not inspect form values or arbitrary page text merely to surface the entry.
 */
export function classifyRecruitmentPage(input: PageClassificationInput): RecruitmentPageDetection {
  const adapterId = supportedAtsAdapter(input.url);
  if (!adapterId) return { detected: false, adapterId: null, kind: null, reason: "unsupported_host" };

  const parsed = new URL(input.url);
  const route = `${parsed.pathname}${parsed.hash}`;
  if (parsed.hostname.toLowerCase() === "we.zyt.com" && /^\/form\/?$/i.test(parsed.pathname) && parsed.searchParams.has("jobAdId")) {
    return { detected: true, adapterId, kind: "application_form", reason: "application_route" };
  }
  if (APPLICATION_ROUTE.test(route)) {
    return { detected: true, adapterId, kind: "application_form", reason: "application_route" };
  }
  if (JOB_ROUTE.test(route)) {
    return { detected: true, adapterId, kind: "job_detail", reason: "job_route" };
  }
  if (RECRUITMENT_TITLE.test(input.title ?? "")) {
    return { detected: true, adapterId, kind: "job_detail", reason: "recruitment_title" };
  }
  return { detected: false, adapterId, kind: null, reason: "unknown_route" };
}
