import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface PickedFile {
  path: string;
  filename: string;
}

export interface AttachmentPayload {
  data_base64: string;
  size_bytes: number;
}

const ALLOWED_EXTENSIONS = [
  "csv",
  "doc",
  "docx",
  "gif",
  "html",
  "jpeg",
  "jpg",
  "json",
  "md",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "svg",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "xml",
  "yaml",
  "yml",
];

export async function pickAttachmentFiles(): Promise<PickedFile[]> {
  const result = await open({
    multiple: true,
    directory: false,
    filters: [
      {
        name: "Documents and images",
        extensions: ALLOWED_EXTENSIONS,
      },
    ],
  });
  if (!result) return [];
  const paths = Array.isArray(result) ? result : [result];
  return paths.map((path) => {
    const segments = path.split(/[\\/]/);
    return { path, filename: segments[segments.length - 1] || path };
  });
}

export async function readFileBase64(path: string): Promise<AttachmentPayload> {
  return await invoke<AttachmentPayload>("read_file_base64", { path });
}

const EXTENSION_TO_MIME: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

export function inferMediaType(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return "application/octet-stream";
  const ext = filename.slice(dotIdx + 1).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

export function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}
