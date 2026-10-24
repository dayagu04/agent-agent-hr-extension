declare module "mammoth/mammoth.browser" {
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
}

declare module "*.css?inline" {
  const css: string;
  export default css;
}

declare module "*.css";

declare module "*.mjs?url" {
  const url: string;
  export default url;
}
