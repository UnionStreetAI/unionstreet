/**
 * Normalize user-pasted provider base URLs into an API root.
 *
 * People paste all kinds of nearby URLs: host roots, `/models`,
 * `/chat/completions`, docs pages, and trailing slashes. For
 * OpenAI-compatible providers the useful root is usually either the
 * existing `/v1` URL or the host root that can be probed with `/v1`.
 */
export function sanitizeOpenAICompatBaseUrl(input: string): string {
  let raw = input.trim();
  if (!raw) return raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.replace(/\/+$/, "");
  }

  url.hash = "";
  url.search = "";

  const parts = url.pathname.split("/").filter(Boolean);
  const lowered = parts.map((p) => p.toLowerCase());

  const modelsIdx = lowered.lastIndexOf("models");
  if (modelsIdx >= 0) {
    url.pathname = `/${parts.slice(0, modelsIdx).join("/")}`;
    return trimUrl(url);
  }

  const chatIdx = lowered.lastIndexOf("chat");
  if (chatIdx >= 0 && lowered[chatIdx + 1] === "completions") {
    url.pathname = `/${parts.slice(0, chatIdx).join("/")}`;
    return trimUrl(url);
  }

  const completionsIdx = lowered.lastIndexOf("completions");
  if (completionsIdx >= 0) {
    url.pathname = `/${parts.slice(0, completionsIdx).join("/")}`;
    return trimUrl(url);
  }

  return trimUrl(url);
}

function trimUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}
